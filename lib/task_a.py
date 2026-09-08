"""Task A — Production Requirement Report.

To produce = MAX(Requested qty - On-hand qty, 0), grouped by (Item number, Warehouse).
On-hand must be summed across batch rows per (Item, Warehouse) — never across warehouses.
"""

import pandas as pd

from lib.sku_rules import is_excluded_sku, normalize_sku

TOTALS_LABEL = "TOTAL"


def compute_production_requirement(
    requested_df,
    onhand_df,
    requested_cols,
    onhand_cols,
    show_all_rows=True,
    onorder_df=None,
    onorder_cols=None,
):
    """requested_cols / onhand_cols: dicts mapping logical field -> actual column
    name, e.g. {"item": "Item number", "warehouse": "Warehouse", "qty": "Quantity"}
    and {"item": "Item number", "warehouse": "Warehouse", "available": "Available physical",
    "product_name": "Product name" (optional)}.

    onorder_df / onorder_cols: optional D365 on-order (incoming/in-production)
    export — {"item": ..., "warehouse": ..., "qty": ...} — added to on-hand
    when computing To produce, so already-incoming stock isn't double-counted
    as a shortfall. Omit both to keep the plain Requested-vs-On-hand behavior.

    Returns (per_warehouse_tables, diagnostics) where per_warehouse_tables is
    {warehouse: DataFrame} already sorted/totaled, and diagnostics is a dict of
    counts useful for a pre-download sanity-check preview.
    """
    diagnostics = {}
    have_onorder = onorder_df is not None and onorder_cols is not None

    req = requested_df[[requested_cols["item"], requested_cols["warehouse"], requested_cols["qty"]]].copy()
    req.columns = ["item", "warehouse", "qty"]

    onh_cols = [onhand_cols["item"], onhand_cols["warehouse"], onhand_cols["available"]]
    have_product_name = "product_name" in onhand_cols and onhand_cols["product_name"] in onhand_df.columns
    if have_product_name:
        onh_cols.append(onhand_cols["product_name"])
    onh = onhand_df[onh_cols].copy()
    onh.columns = ["item", "warehouse", "available"] + (["product_name"] if have_product_name else [])

    for df in (req, onh):
        df["item"] = df["item"].map(normalize_sku)

    diagnostics["requested_rows_in"] = len(req)
    diagnostics["onhand_rows_in"] = len(onh)

    req = req[~req["item"].map(is_excluded_sku)]
    onh = onh[~onh["item"].map(is_excluded_sku)]
    diagnostics["requested_excluded_sku_rows"] = diagnostics["requested_rows_in"] - len(req)
    diagnostics["onhand_excluded_sku_rows"] = diagnostics["onhand_rows_in"] - len(onh)

    blank_wh_mask = req["warehouse"].isna() | (req["warehouse"].astype(str).str.strip() == "")
    diagnostics["requested_blank_warehouse_dropped"] = int(blank_wh_mask.sum())
    req = req[~blank_wh_mask]

    req["qty"] = pd.to_numeric(req["qty"], errors="coerce").fillna(0)
    onh["available"] = pd.to_numeric(onh["available"], errors="coerce").fillna(0)

    req_agg = req.groupby(["item", "warehouse"], as_index=False)["qty"].sum()
    onh_agg = onh.groupby(["item", "warehouse"], as_index=False)["available"].sum()

    if have_onorder:
        onor = onorder_df[[onorder_cols["item"], onorder_cols["warehouse"], onorder_cols["qty"]]].copy()
        onor.columns = ["item", "warehouse", "onorder"]
        onor["item"] = onor["item"].map(normalize_sku)
        diagnostics["onorder_rows_in"] = len(onor)
        onor = onor[~onor["item"].map(is_excluded_sku)]
        diagnostics["onorder_excluded_sku_rows"] = diagnostics["onorder_rows_in"] - len(onor)
        onor["onorder"] = pd.to_numeric(onor["onorder"], errors="coerce").fillna(0)
        onor_agg = onor.groupby(["item", "warehouse"], as_index=False)["onorder"].sum()

    product_names = None
    if have_product_name:
        product_names = (
            onh.dropna(subset=["product_name"])
            .drop_duplicates(subset=["item"])
            .set_index("item")["product_name"]
        )

    merged = req_agg.merge(onh_agg, on=["item", "warehouse"], how="left")
    merged["available"] = merged["available"].fillna(0)
    if have_onorder:
        merged = merged.merge(onor_agg, on=["item", "warehouse"], how="left")
        merged["onorder"] = merged["onorder"].fillna(0)
    else:
        merged["onorder"] = 0
    merged["to_produce"] = (merged["qty"] - merged["available"] - merged["onorder"]).clip(lower=0)
    if have_onorder:
        # Incoming/in-production qty beyond what's needed for the currently-known
        # shortfall — a potential over-ordering signal, not itself a shortfall.
        merged["extra_on_order"] = (merged["onorder"] - merged["to_produce"]).clip(lower=0)

    if product_names is not None:
        merged["product_name"] = merged["item"].map(product_names)
    else:
        merged["product_name"] = ""

    if not show_all_rows:
        merged = merged[merged["to_produce"] > 0]

    diagnostics["output_rows"] = len(merged)
    diagnostics["warehouses"] = sorted(merged["warehouse"].dropna().unique().tolist())

    onorder_col_names = ["item", "product_name", "qty", "available", "onorder", "to_produce", "extra_on_order"]
    onorder_rename = {
        "item": "Item number", "product_name": "Product name", "qty": "Requested qty",
        "available": "On-hand qty", "onorder": "On-order qty", "to_produce": "To produce",
        "extra_on_order": "Extra on order",
    }
    if not have_onorder:
        for key in ("onorder", "extra_on_order"):
            onorder_col_names.remove(key)
            del onorder_rename[key]

    per_warehouse = {}
    for wh, group in merged.groupby("warehouse"):
        table = group.sort_values("to_produce", ascending=False)[onorder_col_names].rename(columns=onorder_rename)
        totals = {
            "Item number": TOTALS_LABEL,
            "Product name": "",
            "Requested qty": table["Requested qty"].sum(),
            "On-hand qty": table["On-hand qty"].sum(),
            "To produce": table["To produce"].sum(),
        }
        if have_onorder:
            totals["On-order qty"] = table["On-order qty"].sum()
            totals["Extra on order"] = table["Extra on order"].sum()
        table = pd.concat([table, pd.DataFrame([totals])], ignore_index=True)
        per_warehouse[wh] = table

    return per_warehouse, diagnostics
