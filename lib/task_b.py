"""Task B — Fulfillment Check Report.

Join open sales-order lines to shipped lines from a warehouse fulfillment report,
per order: Shipped / Partially Shipped / Not Fulfilled.
"""

import pandas as pd

from lib.sku_rules import is_service_sku, normalize_sku
from lib.status_i18n import normalize_status

MULTI_TRACKING_FLAG = "Multiple tracking numbers on this order — verify manually"


def build_join_key(df, so_col, shopify_col=None, item_col=None):
    """Per-row join key: Sales order number when present/non-blank, else a
    Shopify-reference-based fallback (composed with Item number when given —
    both sides of a join must agree on whether item_col is used, since it
    changes the fallback key's granularity from per-order to per-SKU-line)."""
    so = df[so_col].astype(str).str.strip() if so_col else pd.Series([""] * len(df), index=df.index)
    has_so = so.notna() & (so != "") & (so.str.lower() != "nan")

    if shopify_col and item_col:
        shopify = df[shopify_col].astype(str).str.strip()
        item = df[item_col].astype(str).str.strip()
        fallback = "SHOPIFY::" + shopify + "::" + item
    elif shopify_col:
        fallback = "SHOPIFY::" + df[shopify_col].astype(str).str.strip()
    else:
        fallback = pd.Series([None] * len(df), index=df.index)

    return so.where(has_so, fallback)


def _pick_status(ordered_qty, shipped_qty):
    if shipped_qty <= 0:
        return "Not Fulfilled"
    if shipped_qty >= ordered_qty:
        return "Shipped"
    return "Partially Shipped"


def compute_fulfillment_check(
    open_so_df,
    fulfillment_df,
    open_so_cols,
    fulfillment_cols,
):
    """open_so_cols: {"key": <join key column, prebuilt via build_join_key>,
    "item": ..., "warehouse": ..., "ordered_qty": ...}
    fulfillment_cols: {"key": ..., "item": ..., "bundle_item": optional,
    "shipped_qty": ..., "tracking": ..., "shipped_date": ..., "status": optional}

    Returns (per_sheet_tables, diagnostics). per_sheet_tables keys are
    "<Warehouse> (<Status>)".
    """
    diagnostics = {}

    ordered = open_so_df[
        [open_so_cols["key"], open_so_cols["item"], open_so_cols["warehouse"], open_so_cols["ordered_qty"]]
    ].copy()
    ordered.columns = ["key", "item", "warehouse", "ordered_qty"]
    ordered["item"] = ordered["item"].map(normalize_sku)
    ordered["ordered_qty"] = pd.to_numeric(ordered["ordered_qty"], errors="coerce").fillna(0)
    # dropna=False: pandas drops NaN-keyed groups by default, which would
    # silently vanish blank-warehouse lines before the "Unassigned" bucketing
    # logic below ever gets a chance to run.
    ordered = ordered.groupby(["key", "item", "warehouse"], as_index=False, dropna=False)["ordered_qty"].sum()

    ship_cols = [fulfillment_cols["key"], fulfillment_cols["item"], fulfillment_cols["shipped_qty"],
                 fulfillment_cols["tracking"], fulfillment_cols["shipped_date"]]
    has_bundle = "bundle_item" in fulfillment_cols and fulfillment_cols["bundle_item"] in fulfillment_df.columns
    if has_bundle:
        ship_cols.append(fulfillment_cols["bundle_item"])
    has_status = "status" in fulfillment_cols and fulfillment_cols["status"] in fulfillment_df.columns
    if has_status:
        ship_cols.append(fulfillment_cols["status"])

    shipped = fulfillment_df[ship_cols].copy()
    base_names = ["key", "item", "shipped_qty", "tracking", "shipped_date"]
    if has_bundle:
        base_names.append("bundle_item")
    if has_status:
        base_names.append("status")
    shipped.columns = base_names

    shipped["item"] = shipped["item"].map(normalize_sku)
    if has_bundle:
        shipped["bundle_item"] = shipped["bundle_item"].map(
            lambda v: normalize_sku(v) if pd.notna(v) else v
        )
    if has_status:
        shipped["status"] = shipped["status"].map(normalize_status)
    shipped["shipped_qty"] = pd.to_numeric(shipped["shipped_qty"], errors="coerce").fillna(0)

    diagnostics["ordered_lines"] = len(ordered)
    diagnostics["shipped_lines"] = len(shipped)

    agg_kwargs = dict(shipped_qty=("shipped_qty", "sum"))
    if has_status:
        agg_kwargs["status"] = ("status", "first")

    # Pass 1: direct (key, item) match on SKU — quantity only; tracking/date
    # are resolved at the whole-order level below (see spec: "one tracking
    # number per sales order max in most cases").
    direct = shipped.groupby(["key", "item"], as_index=False).agg(**agg_kwargs)

    # Pass 2: bundle-SKU fallback lookup, keyed by (key, bundle_item).
    bundle_lookup = None
    if has_bundle:
        bundle_rows = shipped.dropna(subset=["bundle_item"])
        if len(bundle_rows):
            bundle_lookup = bundle_rows.groupby(["key", "bundle_item"], as_index=False).agg(**agg_kwargs)

    direct_idx = direct.set_index(["key", "item"])
    bundle_idx = bundle_lookup.set_index(["key", "bundle_item"]) if bundle_lookup is not None else None

    def lookup_shipped(row):
        k = (row["key"], row["item"])
        if k in direct_idx.index:
            hit = direct_idx.loc[k]
            return hit["shipped_qty"], (hit["status"] if has_status else None)
        if bundle_idx is not None and k in bundle_idx.index:
            hit = bundle_idx.loc[k]
            diagnostics["bundle_sku_recovered"] = diagnostics.get("bundle_sku_recovered", 0) + 1
            return hit["shipped_qty"], (hit["status"] if has_status else None)
        return 0, None

    lookups = ordered.apply(lookup_shipped, axis=1, result_type="expand")
    lookups.columns = ["shipped_qty", "source_status"]
    ordered = pd.concat([ordered, lookups], axis=1)

    ordered["is_service"] = ordered["item"].map(is_service_sku)
    ordered["outstanding_qty"] = ordered["ordered_qty"] - ordered["shipped_qty"]

    # Whole-order tracking/shipped-date resolution: normally one shipment (and
    # therefore one tracking number) covers an entire order. If the fulfillment
    # report shows more than one distinct tracking number for the same order,
    # use the first-seen one for every line and flag the order for manual
    # verification rather than silently dropping the others.
    order_tracking = {}
    for key, group in shipped.groupby("key"):
        distinct = list(dict.fromkeys(group["tracking"].dropna()))
        if not distinct:
            order_tracking[key] = (None, None, False)
            continue
        first = distinct[0]
        dates = group.loc[group["tracking"] == first, "shipped_date"].dropna()
        order_tracking[key] = (first, dates.iloc[0] if len(dates) else None, len(distinct) > 1)

    ordered["tracking_number"] = ordered["key"].map(lambda k: order_tracking.get(k, (None, None, False))[0])
    ordered["order_shipped_date"] = ordered["key"].map(lambda k: order_tracking.get(k, (None, None, False))[1])
    ordered["flag"] = ordered["key"].map(
        lambda k: MULTI_TRACKING_FLAG if order_tracking.get(k, (None, None, False))[2] else ""
    )
    diagnostics["multi_tracking_orders"] = sum(1 for v in order_tracking.values() if v[2])

    # Only lines that were actually shipped carry tracking/date; service lines
    # are the one exception (spec: they may inherit from the order's FG line).
    carries_tracking = (ordered["shipped_qty"] > 0) | ordered["is_service"]
    ordered["shipped_date"] = ordered["order_shipped_date"].where(carries_tracking)
    ordered["tracking_number"] = ordered["tracking_number"].where(carries_tracking)

    # Per-order status excludes service lines from the shortfall determination.
    status_basis = ordered[~ordered["is_service"]]
    order_totals = status_basis.groupby("key", as_index=False).agg(
        ordered_qty=("ordered_qty", "sum"), shipped_qty=("shipped_qty", "sum")
    )
    order_totals["status"] = order_totals.apply(
        lambda r: _pick_status(r["ordered_qty"], r["shipped_qty"]), axis=1
    )
    # Orders that are ONLY service lines (no FG lines) fall back to a
    # straight shipped-vs-ordered check across all lines.
    all_keys = set(ordered["key"].unique())
    covered_keys = set(order_totals["key"].unique())
    for k in all_keys - covered_keys:
        sub = ordered[ordered["key"] == k]
        status = _pick_status(sub["ordered_qty"].sum(), sub["shipped_qty"].sum())
        order_totals = pd.concat(
            [order_totals, pd.DataFrame([{"key": k, "ordered_qty": sub["ordered_qty"].sum(),
                                            "shipped_qty": sub["shipped_qty"].sum(), "status": status}])],
            ignore_index=True,
        )

    status_map = order_totals.set_index("key")["status"]
    ordered["order_status"] = ordered["key"].map(status_map)

    blank_wh_mask = ordered["warehouse"].isna() | (ordered["warehouse"].astype(str).str.strip() == "")
    diagnostics["blank_warehouse_lines"] = int(blank_wh_mask.sum())
    ordered.loc[blank_wh_mask, "warehouse"] = "Unassigned"

    cols = ["key", "item", "ordered_qty", "shipped_qty", "tracking_number", "shipped_date",
            "outstanding_qty", "flag"]
    rename_map = {
        "key": "Sales order number",
        "item": "SKU",
        "ordered_qty": "Ordered qty",
        "shipped_qty": "Shipped qty",
        "tracking_number": "Tracking number",
        "shipped_date": "Shipped date",
        "outstanding_qty": "Outstanding qty",
        "flag": "Flag",
    }
    if has_status:
        cols.insert(-1, "source_status")
        rename_map["source_status"] = "Source status"

    per_sheet = {}
    for (warehouse, status), group in ordered.groupby(["warehouse", "order_status"]):
        table = group.sort_values("key")[cols].rename(columns=rename_map)
        sheet_name = f"{warehouse} ({status})"
        per_sheet[sheet_name] = table

    diagnostics["orders"] = ordered["key"].nunique()
    diagnostics["status_breakdown"] = order_totals["status"].value_counts().to_dict()

    return per_sheet, diagnostics
