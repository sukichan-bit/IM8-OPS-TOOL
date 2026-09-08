"""Manual test script for Task B logic — real SO Status lines (scope: Remarks in
['Ops - refund order', 'Ops - to manually fulfil and adjust inventory']) as the
ordered side, synthetic fulfillment data covering: full ship, partial ship,
not-fulfilled, bundle-SKU recovery, multi-tracking flag, service-line tracking
inheritance, and Chinese status normalization.
"""

import sys

BASE = r"C:/Users/suki.chan_prenetics/Desktop/Claude/im8-open-SO-fulfillment-checking-tools"
sys.path.insert(0, BASE)

import pandas as pd

from lib.task_b import compute_fulfillment_check, build_join_key

soso_path = f"{BASE}/samples/20260723 H007 Open SO (Jul22).xlsx"
so_df = pd.read_excel(soso_path, sheet_name="SO Status", header=3)
so_df.columns = [str(c).strip() for c in so_df.columns]
scope = so_df[
    so_df["Remarks"].isin(["Ops - refund order", "Ops - to manually fulfil and adjust inventory"])
].copy()

# Use these real orders for the synthetic scenarios (picked from the scope subset):
#  H007-SO-032755   -> full ship (FG line) + service line (should inherit tracking)
#  H007-SO-209453   -> partial ship (2 of 4 lines shipped, 1 line partial qty)
#  H007-SO-212770   -> not fulfilled (no shipment at all)
#  H007-SO-214204   -> bundle-SKU recovery (shipped under a bundle SKU)
#  H007-SO-203421   -> multi-tracking flag (two different tracking numbers on the order)

open_so = scope[
    scope["Sales order"].isin(
        ["H007-SO-032755", "H007-SO-209453", "H007-SO-212770", "H007-SO-214204", "H007-SO-203421"]
    )
].copy()
print("open_so rows used:", len(open_so))
print(open_so[["Sales order", "Item number", "Shopify reference", "Warehouse", "Quantity"]].to_string())

open_so["key"] = build_join_key(open_so, "Sales order")
open_so["Warehouse"] = open_so["Warehouse"].fillna("OPS-WH01")  # give the blank ones a home for this test

fulfillment_rows = [
    # H007-SO-032755: FG line fully shipped; service line gets no direct shipment row.
    {"key": "H007-SO-032755", "SKU": "IM8-FG-000040", "Bundle SKU": None, "Shipped qty": 1,
     "Tracking number": "TRACK-A1", "Shipped date": "2026-07-01", "Status": "已出庫"},

    # H007-SO-209453: partial — IM8-FG-000029 shipped in full (qty1), IM8-FG-000143 partial (ordered 2, shipped 1).
    {"key": "H007-SO-209453", "SKU": "IM8-FG-000029", "Bundle SKU": None, "Shipped qty": 1,
     "Tracking number": "TRACK-B1", "Shipped date": "2026-07-02", "Status": "已出庫"},
    {"key": "H007-SO-209453", "SKU": "IM8-FG-000143", "Bundle SKU": None, "Shipped qty": 1,
     "Tracking number": "TRACK-B1", "Shipped date": "2026-07-02", "Status": "已出庫"},
    # (IM8-FG-000243 and IM8-FG-000242 on this order get nothing shipped -> partial overall)

    # H007-SO-212770: no shipment rows at all -> Not Fulfilled.

    # H007-SO-214204: shipped under a bundle SKU, not the raw item -> bundle-aware recovery.
    {"key": "H007-SO-214204", "SKU": "BUNDLE-XYZ-001", "Bundle SKU": "IM8-FG-000242", "Shipped qty": 1,
     "Tracking number": "TRACK-D1", "Shipped date": "2026-07-03", "Status": "已出庫"},

    # H007-SO-203421: two lines, each with a DIFFERENT tracking number -> multi-tracking flag.
    {"key": "H007-SO-203421", "SKU": "IM8-FG-000143", "Bundle SKU": None, "Shipped qty": 2,
     "Tracking number": "TRACK-E1", "Shipped date": "2026-07-04", "Status": "已出庫"},
    {"key": "H007-SO-203421", "SKU": "IM8-FG-000242", "Bundle SKU": None, "Shipped qty": 1,
     "Tracking number": "TRACK-E2", "Shipped date": "2026-07-04", "Status": "已出庫"},
]
fulfillment_df = pd.DataFrame(fulfillment_rows)

open_so_cols = {"key": "key", "item": "Item number", "warehouse": "Warehouse", "ordered_qty": "Quantity"}
fulfillment_cols = {
    "key": "key", "item": "SKU", "bundle_item": "Bundle SKU", "shipped_qty": "Shipped qty",
    "tracking": "Tracking number", "shipped_date": "Shipped date", "status": "Status",
}

per_sheet, diagnostics = compute_fulfillment_check(open_so, fulfillment_df, open_so_cols, fulfillment_cols)

print("\nDIAGNOSTICS:", diagnostics)
for name, table in per_sheet.items():
    print("=" * 70)
    print(name)
    print(table.to_string())

# --- Assertions ---
all_rows = pd.concat(per_sheet.values(), ignore_index=True)


def status_of(sheet_prefix):
    return [n for n in per_sheet if n.startswith(sheet_prefix)]


so_032755 = all_rows[all_rows["Sales order number"] == "H007-SO-032755"]
fg_032755 = so_032755[so_032755["SKU"] != "IM8-SER-000003"]
assert (fg_032755["Shipped qty"].sum() == fg_032755["Ordered qty"].sum()), "032755 FG lines should be fully shipped"
service_row = so_032755[so_032755["SKU"] == "IM8-SER-000003"]
assert service_row["Tracking number"].iloc[0] == "TRACK-A1", "service line should inherit tracking from FG line"
assert service_row["Shipped date"].iloc[0] == "2026-07-01", "service line should inherit shipped date"

so_209453 = all_rows[all_rows["Sales order number"] == "H007-SO-209453"]
assert so_209453["Outstanding qty"].sum() > 0, "209453 should have outstanding qty (partial)"

so_212770 = all_rows[all_rows["Sales order number"] == "H007-SO-212770"]
assert (so_212770["Shipped qty"] == 0).all(), "212770 should be fully unshipped"

so_214204 = all_rows[all_rows["Sales order number"] == "H007-SO-214204"]
bundle_line = so_214204[so_214204["SKU"] == "IM8-FG-000242"]
assert bundle_line["Shipped qty"].iloc[0] == 1, "214204 should recover shipped qty via bundle SKU"
assert bundle_line["Tracking number"].iloc[0] == "TRACK-D1"

so_203421 = all_rows[all_rows["Sales order number"] == "H007-SO-203421"]
assert (so_203421["Flag"] == "Multiple tracking numbers on this order — verify manually").any(), \
    "203421 should be flagged for multiple tracking numbers"

assert diagnostics["bundle_sku_recovered"] >= 1
assert diagnostics["multi_tracking_orders"] >= 1

sheet_names = list(per_sheet.keys())
assert any("(Shipped)" in n for n in sheet_names)
assert any("(Partially Shipped)" in n for n in sheet_names)
assert any("(Not Fulfilled)" in n for n in sheet_names)

print("\nALL TASK B ASSERTIONS PASSED")
