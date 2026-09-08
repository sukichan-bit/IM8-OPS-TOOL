"""E2E test of the order-level fallback path (fulfillment report with no SKU
column, like the real OPS-WH03 export) through the actual app UI.
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

wh03_path = f"{BASE}/samples/20260701-20260723 OPS-WH03 Fulfillment Report.xlsx"
wh03_df = pd.read_excel(wh03_path, sheet_name="data")

wh03_orders = set(wh03_df["Order Number"].dropna().unique())
# Deliberately NOT pre-filling blank Warehouse or truncating to head(200) —
# use the full real match set so this exercises the app's own "Unassigned"
# bucketing for the order-level fallback path exactly as production would see it.
open_so_wh03 = so_df[so_df["Shopify reference"].isin(wh03_orders)].copy()

so_buf = io.BytesIO()
open_so_wh03.to_excel(so_buf, index=False)
so_bytes = so_buf.getvalue()

ful_buf = io.BytesIO()
wh03_df.to_excel(ful_buf, index=False)
ful_bytes = ful_buf.getvalue()

at = AppTest.from_file(f"{BASE}/app.py")
at.run(timeout=60)
assert not at.exception

b_so_uploader = by_key(at.file_uploader, "b_so")[0]
b_ful_uploader = by_key(at.file_uploader, "b_fulfillment")[0]
b_so_uploader.set_value(("open_so.xlsx", so_bytes, XLSX_MIME))
b_ful_uploader.set_value(("wh03_fulfillment.xlsx", ful_bytes, XLSX_MIME))
at.run(timeout=60)
assert not at.exception, f"App raised after file upload: {at.exception}"

# This dataset has a Remarks column, so the app defaults to the narrow
# refund/manual-fulfil scope. Select every Remarks value instead, since this
# test is validating order-level-mode matching broadly, not that one scope.
remarks_multiselect = by_key(at.multiselect, "b_remarks_filter")
if remarks_multiselect:
    remarks_multiselect[0].set_value(list(remarks_multiselect[0].options))
    at.run(timeout=60)
    assert not at.exception, f"App raised after selecting all Remarks: {at.exception}"

info_texts = [i.value for i in at.info]
print("Info messages shown:", info_texts)
assert any("order-level" in t.lower() for t in info_texts), "expected the order-level fallback notice to appear"

assert len(at.download_button) >= 1, "Expected a download button to appear automatically after upload"
diag_by_file = at.json[0].value
if isinstance(diag_by_file, str):
    import json
    diag_by_file = json.loads(diag_by_file)
print("Diagnostics:", diag_by_file)
diag = next(iter(diag_by_file.values()))
assert diag["orders"] > 0
# Cross-checked directly against a raw pandas groupby of the same real data
# (see debugging session): 2017 grouped lines, 1982 orders. blank_warehouse_lines
# is correctly 0 here — blanks are converted to "Unassigned" earlier in
# render_task_b, before this diagnostic is computed; checked via the sheet below.
assert diag["ordered_lines"] == 2017, f"expected 2017 grouped lines, got {diag['ordered_lines']}"
assert diag["orders"] == 1982, f"expected 1982 orders, got {diag['orders']}"
assert diag["status_breakdown"] == {"Shipped": 1982}, f"expected all 1982 Shipped, got {diag['status_breakdown']}"

markdown_texts = [m.value for m in at.markdown]
sheet_names = [t.strip("*") for t in markdown_texts if t.startswith("**") and "(" in t]
print("Output sheet names:", sheet_names)
assert any(s.startswith("Unassigned") and "42 rows" in s for s in sheet_names), \
    f"expected an 'Unassigned (Shipped) — 42 rows' sheet, got {sheet_names}"

print("\nORDER-LEVEL FALLBACK E2E TEST PASSED")
