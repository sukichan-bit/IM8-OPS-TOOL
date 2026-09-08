"""Validate Task B against the REAL warehouse fulfillment reports (added after
the initial synthetic test): OPS-WH02 (Chinese WMS, wide 'SKU 1..7' block
format, needs unpivoting) and OPS-WH03 (3PL shipping summary, order-level only,
no SKU column at all -> exercises the order-level fallback mode).
"""

import sys

BASE = r"C:/Users/suki.chan_prenetics/Desktop/Claude/im8-open-SO-fulfillment-checking-tools"
sys.path.insert(0, BASE)

import pandas as pd

from lib.io_utils import has_sku_blocks, unpivot_sku_blocks, fuzzy_match_column
from lib.task_b import build_join_key, compute_fulfillment_check

soso_path = f"{BASE}/samples/20260723 H007 Open SO (Jul22).xlsx"
so_df = pd.read_excel(soso_path, sheet_name="SO Status", header=3)
so_df.columns = [str(c).strip() for c in so_df.columns]
scope = so_df[
    so_df["Remarks"].isin(["Ops - refund order", "Ops - to manually fulfil and adjust inventory"])
].copy()

print("=" * 70)
print("WH02 (per-SKU wide-block format)")
wh02_path = f"{BASE}/samples/20260701-20260723 OPS-WH02 Fulfillment Report.xlsx"
wh02_df = pd.read_excel(wh02_path, sheet_name="出库单")
assert has_sku_blocks(wh02_df.columns)
wh02_long = unpivot_sku_blocks(wh02_df)
print("unpivoted rows:", len(wh02_long))

# Use real open-SO lines whose Sales order numbers actually appear in the WH02
# report, so the join has genuine overlap to validate against.
wh02_orders = set(wh02_long["Reference order No./参考单号"].dropna().unique())
open_so_wh02 = scope[scope["Warehouse"] == "OPS-WH02"].copy()
overlap = open_so_wh02[open_so_wh02["Sales order"].isin(wh02_orders)]
print("open_so rows at OPS-WH02 in scope:", len(open_so_wh02), "| overlapping with WH02 report:", len(overlap))

# Broaden: also check overlap across the whole SO Status sheet (not just the
# refund/manual-fulfil scope) since WH02's shipped orders may not all fall in
# that narrow scope — this just proves the join mechanics work end-to-end.
so_open_so = so_df[so_df["Warehouse"] == "OPS-WH02"].copy()
so_overlap = so_open_so[so_open_so["Sales order"].isin(wh02_orders)]
print("full SO Status rows at OPS-WH02:", len(so_open_so), "| overlapping with WH02 report:", len(so_overlap))

test_so = so_overlap.copy()
test_so["__key"] = build_join_key(test_so, "Sales order")
wh02_long["__key"] = build_join_key(wh02_long, "Reference order No./参考单号")

open_so_cols = {"key": "__key", "item": "Item number", "warehouse": "Warehouse", "ordered_qty": "Quantity"}
ful_cols = {
    "key": "__key", "item": "SKU", "shipped_qty": "Outbound Qty",
    "tracking": "Tracking No./物流跟踪号", "shipped_date": "OutboundTime/出库时间",
    "status": "Status/状态",
}
per_sheet, diagnostics = compute_fulfillment_check(test_so, wh02_long, open_so_cols, ful_cols)
print("WH02 diagnostics:", diagnostics)
for name, table in per_sheet.items():
    print(f"  {name}: {len(table)} rows")
assert diagnostics["orders"] > 0, "expected at least some matched orders for WH02"
assert diagnostics["status_breakdown"].get("Shipped", 0) > 0, "expected some fully-shipped orders (matches 已出库 status)"
print("WH02 REAL-DATA TEST PASSED")

print("=" * 70)
print("WH03 (order-level-only format, no SKU column)")
wh03_path = f"{BASE}/samples/20260701-20260723 OPS-WH03 Fulfillment Report.xlsx"
wh03_df = pd.read_excel(wh03_path, sheet_name="data")
assert not has_sku_blocks(wh03_df.columns)
assert fuzzy_match_column(wh03_df.columns, ["sku", "item number", "item"]) is None, "WH03 should have no SKU column"

wh03_orders = set(wh03_df["Order Number"].dropna().unique())
open_so_wh03 = so_df[so_df["Shopify reference"].isin(wh03_orders)].copy()
print("open_so rows matching a WH03 order number:", len(open_so_wh03))
assert len(open_so_wh03) > 0, "expected some real open-SO rows to match WH03's Order Number (Shopify ref) values"

# Order-level mode: both sides key on Shopify reference alone (item excluded).
test_so3 = open_so_wh03.copy()
test_so3["__key"] = build_join_key(test_so3, None, "Shopify reference", None)
wh03_df["__key"] = build_join_key(wh03_df, None, "Order Number", None)

PLACEHOLDER_ITEM = "(All SKUs — order-level match)"
so_work3 = test_so3.groupby(["__key", "Warehouse"], as_index=False)["Quantity"].sum()
so_work3["__item"] = PLACEHOLDER_ITEM
wh03_df["__item"] = PLACEHOLDER_ITEM
wh03_df["Warehouse"] = "OPS-WH03"  # not used for matching, just to avoid KeyError if referenced

open_so_cols3 = {"key": "__key", "item": "__item", "warehouse": "Warehouse", "ordered_qty": "Quantity"}
ful_cols3 = {
    "key": "__key", "item": "__item", "shipped_qty": "Quantity Shipped",
    "tracking": "Tracking Number", "shipped_date": "Order Shipped At", "status": "Order Status",
}
per_sheet3, diagnostics3 = compute_fulfillment_check(so_work3, wh03_df, open_so_cols3, ful_cols3)
print("WH03 diagnostics:", diagnostics3)
for name, table in per_sheet3.items():
    print(f"  {name}: {len(table)} rows")
assert diagnostics3["orders"] > 0
print("WH03 REAL-DATA TEST PASSED")
