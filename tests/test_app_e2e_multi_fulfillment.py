"""E2E test: Task B with TWO separate fulfillment reports uploaded at once (one
per warehouse), through the actual app UI — this is the new multi-file feature.
Uses the real OPS-WH02 (wide SKU-block) and OPS-WH03 (order-level-only) reports.
"""

import io
import sys

BASE = r"C:/Users/suki.chan_prenetics/Desktop/Claude/im8-open-SO-fulfillment-checking-tools"
sys.path.insert(0, BASE)

import pandas as pd
from streamlit.testing.v1 import AppTest

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def by_key(widgets, key_suffix):
    return [w for w in widgets if w.key and w.key.endswith(key_suffix)]


soso_path = f"{BASE}/samples/20260723 H007 Open SO (Jul22).xlsx"
so_df = pd.read_excel(soso_path, sheet_name="SO Status", header=3)
so_df.columns = [str(c).strip() for c in so_df.columns]
scope = so_df[so_df["Remarks"].isin(["Ops - refund order", "Ops - to manually fulfil and adjust inventory"])].copy()
# Deliberately NOT pre-filling blank Warehouse here — this exercises the
# app's own "Unassigned" bucketing for real blank-warehouse rows (476 of them
# in this real scope), rather than masking it with test-data cleanup.

so_buf = io.BytesIO()
scope.to_excel(so_buf, index=False)
so_bytes = so_buf.getvalue()

with open(f"{BASE}/samples/20260701-20260723 OPS-WH02 Fulfillment Report.xlsx", "rb") as f:
    wh02_bytes = f.read()
with open(f"{BASE}/samples/20260701-20260723 OPS-WH03 Fulfillment Report.xlsx", "rb") as f:
    wh03_bytes = f.read()

at = AppTest.from_file(f"{BASE}/app.py")
at.run(timeout=60)
assert not at.exception

so_uploader = by_key(at.file_uploader, "b_so")[0]
so_uploader.set_value(("open_so.xlsx", so_bytes, XLSX_MIME))
at.run(timeout=60)
assert not at.exception, f"App raised after open-SO upload: {at.exception}"

ful_uploader = by_key(at.file_uploader, "b_fulfillment")[0]
ful_uploader.set_value([
    ("20260701-20260723 OPS-WH02 Fulfillment Report.xlsx", wh02_bytes, XLSX_MIME),
    ("20260701-20260723 OPS-WH03 Fulfillment Report.xlsx", wh03_bytes, XLSX_MIME),
])
at.run(timeout=90)
assert not at.exception, f"App raised after multi-file upload: {at.exception}"

captions = [c.value for c in at.caption]
print("Captions:", [c for c in captions if "Applies to" in c or "Loaded" in c])

selectboxes = {sb.key: sb.value for sb in at.selectbox}
wh_selectboxes = {k: v for k, v in selectboxes.items() if "b_ful_wh_" in k}
print("Warehouse assignment selectboxes:", wh_selectboxes)
assert set(wh_selectboxes.values()) == {"OPS-WH02", "OPS-WH03"}, \
    f"Expected auto-detected assignment to OPS-WH02/OPS-WH03 from filenames, got {wh_selectboxes}"

errors = [e.value for e in at.error]
print("Errors:", errors)
assert not errors, f"Did not expect validation errors: {errors}"

assert len(at.download_button) >= 1, "Expected a download button after both files processed"

diag = at.json[0].value
if isinstance(diag, str):
    import json
    diag = json.loads(diag)
print("Combined diagnostics keys:", list(diag.keys()))
assert any("WH02" in k for k in diag.keys())
assert any("WH03" in k for k in diag.keys())

markdown_texts = [m.value for m in at.markdown]
sheet_names = [t.strip("*") for t in markdown_texts if t.startswith("**") and "(" in t]
print("Output sheet names:", sheet_names)
assert any("OPS-WH02" in s for s in sheet_names)
assert any("OPS-WH03" in s for s in sheet_names)

# The real refund/manual-fulfil scope has 476 blank-warehouse rows — they must
# surface as "Unassigned (Not Fulfilled)" (476 rows), not silently vanish.
unassigned_sheet = next((s for s in sheet_names if s.startswith("Unassigned (")), None)
assert unassigned_sheet is not None, f"Expected an 'Unassigned (...)' status sheet, got {sheet_names}"
assert "476 rows" in unassigned_sheet, f"Expected 476 rows in Unassigned sheet, got: {unassigned_sheet}"

# Per-warehouse download buttons: one combined summary line per warehouse too.
warehouse_summary = next((s for s in sheet_names if s.startswith("Unassigned") and "total rows across" in s), None)
assert warehouse_summary is not None, f"Expected a per-warehouse summary line for Unassigned, got {sheet_names}"
assert "476 total rows" in warehouse_summary, f"Expected 476 total rows, got: {warehouse_summary}"

print("\nMULTI-FULFILLMENT-FILE E2E TEST PASSED")
