"""End-to-end test of app.py using Streamlit's AppTest — drives the real UI
widget tree (file upload, column mapping selectboxes, generate button) without
needing a browser, since our Browser tool can't automate native file pickers.
"""

import sys

BASE = r"C:/Users/suki.chan_prenetics/Desktop/Claude/im8-open-SO-fulfillment-checking-tools"
sys.path.insert(0, BASE)

import pandas as pd
from streamlit.testing.v1 import AppTest

onhand_path = f"{BASE}/samples/20260723 H007 on-hand (as of 1705).xlsx"
soso_path = f"{BASE}/samples/20260723 H007 Open SO (Jul22).xlsx"

with open(onhand_path, "rb") as f:
    onhand_bytes = f.read()

# Build a "requested inventory" file as an xlsx with the same shape as SO Status
# (the real-world source per user's decision), including the Remarks column.
so_df = pd.read_excel(soso_path, sheet_name="SO Status", header=3)
so_df.columns = [str(c).strip() for c in so_df.columns]

import io

req_buf = io.BytesIO()
so_df.to_excel(req_buf, index=False)
requested_bytes = req_buf.getvalue()

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def by_key(widgets, key_suffix):
    return [w for w in widgets if w.key and w.key.endswith(key_suffix)]


at = AppTest.from_file(f"{BASE}/app.py")
at.run(timeout=60)
assert not at.exception, f"App raised on initial run: {at.exception}"

uploaders = at.file_uploader
req_uploader = by_key(uploaders, "a_requested")[0]
onh_uploader = by_key(uploaders, "a_onhand")[0]

req_uploader.set_value(("SO_Status_requested.xlsx", requested_bytes, XLSX_MIME))
onh_uploader.set_value(("onhand.xlsx", onhand_bytes, XLSX_MIME))
at.run(timeout=60)
assert not at.exception, f"App raised after file upload: {at.exception}"

# Sheet/header/column mapping should all auto-detect; the report should render
# automatically with no button click needed.
errors_before = [e.value for e in at.error]
print("Errors before generate:", errors_before)

download_buttons = by_key(at.download_button, "")
print("Download buttons present:", len(at.download_button))
assert len(at.download_button) >= 1, "Expected a download button to appear after generating Task A report"

json_blocks = at.json
assert len(json_blocks) >= 1, "Expected a diagnostics JSON block"
print("Task A diagnostics:", json_blocks[0].value)

print("\nAPP E2E (Task A) TEST PASSED")

# --- Task B flow: real SO Status lines (refund/manual-fulfil scope) + a small
# synthetic fulfillment report exercising full/partial/not-fulfilled/bundle/
# multi-tracking, same as tests/test_task_b.py but through the actual app UI.
scope_df = so_df[
    so_df["Remarks"].isin(["Ops - refund order", "Ops - to manually fulfil and adjust inventory"])
].copy()
b_open_so_df = scope_df[
    scope_df["Sales order"].isin(["H007-SO-032755", "H007-SO-209453", "H007-SO-212770"])
].copy()
b_open_so_df["Warehouse"] = b_open_so_df["Warehouse"].fillna("OPS-WH01")
b_so_buf = io.BytesIO()
b_open_so_df.to_excel(b_so_buf, index=False)
b_so_bytes = b_so_buf.getvalue()

b_fulfillment_df = pd.DataFrame([
    {"Sales order": "H007-SO-032755", "SKU": "IM8-FG-000040", "Shipped qty": 1,
     "Tracking number": "TRACK-A1", "Shipped date": "2026-07-01", "Status": "已出庫"},
    {"Sales order": "H007-SO-209453", "SKU": "IM8-FG-000029", "Shipped qty": 1,
     "Tracking number": "TRACK-B1", "Shipped date": "2026-07-02", "Status": "已出庫"},
    {"Sales order": "H007-SO-209453", "SKU": "IM8-FG-000143", "Shipped qty": 1,
     "Tracking number": "TRACK-B1", "Shipped date": "2026-07-02", "Status": "已出庫"},
])
b_ful_buf = io.BytesIO()
b_fulfillment_df.to_excel(b_ful_buf, index=False)
b_ful_bytes = b_ful_buf.getvalue()

at2 = AppTest.from_file(f"{BASE}/app.py")
at2.run(timeout=60)
assert not at2.exception

b_so_uploader = by_key(at2.file_uploader, "b_so")[0]
b_ful_uploader = by_key(at2.file_uploader, "b_fulfillment")[0]
b_so_uploader.set_value(("open_so.xlsx", b_so_bytes, XLSX_MIME))
b_ful_uploader.set_value(("fulfillment.xlsx", b_ful_bytes, XLSX_MIME))
at2.run(timeout=60)
assert not at2.exception, f"App raised after Task B file upload: {at2.exception}"

assert len(at2.download_button) >= 1, "Expected a download button to appear automatically after upload"
b_json_blocks = at2.json
assert len(b_json_blocks) >= 1
print("Task B diagnostics:", b_json_blocks[0].value)

import json as _json
diag_by_file = b_json_blocks[0].value
if isinstance(diag_by_file, str):
    diag_by_file = _json.loads(diag_by_file)
diag = next(iter(diag_by_file.values()))
assert diag["orders"] == 3
assert diag["status_breakdown"].get("Shipped") == 1
assert diag["status_breakdown"].get("Partially Shipped") == 1
assert diag["status_breakdown"].get("Not Fulfilled") == 1

print("\nAPP E2E (Task B) TEST PASSED")
