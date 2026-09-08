"""IM8 Open SO Checking Tool (Operations) — Production Requirement (Task A) &
Fulfillment Check (Task B).

See PRENETICS_TOOL_SPEC.md. No data persists beyond the browser session.
"""

import datetime

import pandas as pd
import streamlit as st

from lib.io_utils import (
    fuzzy_match_column,
    guess_header_row,
    guess_warehouse_from_filename,
    has_sku_blocks,
    list_sheets,
    load_table,
    pick_best_sheet,
    read_raw_preview,
    to_excel_bytes,
    unpivot_sku_blocks,
)
from lib.task_a import compute_production_requirement
from lib.task_b import build_join_key, compute_fulfillment_check

st.set_page_config(page_title="IM8 Open SO Checking Tool (Operations)", layout="wide")

TASK_A_REQUESTED_CANDIDATES = {
    "item": ["item number", "sku", "item no", "item"],
    "warehouse": ["warehouse", "site"],
    "qty": ["requested qty", "requested quantity", "quantity", "qty", "ordered qty"],
    "remarks": ["remarks"],
}
TASK_A_ONHAND_CANDIDATES = {
    "item": ["item number", "sku", "item no", "item"],
    "warehouse": ["warehouse", "site"],
    "available": ["available physical", "available physical qty", "available qty"],
    "product_name": ["product name", "item name", "description"],
}
TASK_A_ONORDER_CANDIDATES = {
    "item": ["item number", "sku", "item no", "item"],
    "warehouse": ["warehouse", "site"],
    "qty": ["on order qty", "on order", "ordered qty", "on-order qty", "incoming qty", "quantity"],
}
TASK_B_OPEN_SO_CANDIDATES = {
    "so_number": ["sales order", "sales order number", "so number"],
    "shopify_ref": ["shopify reference", "shopify ref", "reference"],
    "item": ["item number", "sku", "item"],
    "warehouse": ["warehouse", "site"],
    "qty": ["ordered qty", "quantity", "qty"],
    "remarks": ["remarks"],
}
TASK_B_FULFILLMENT_CANDIDATES = {
    "so_number": ["sales order", "sales order number", "so number", "reference order no"],
    "shopify_ref": ["shopify reference", "shopify ref", "reference", "platform order no", "order number", "custom reference"],
    "item": ["sku", "item number", "item"],
    "bundle_item": ["bundle sku", "bundle item", "bundle item number"],
    "shipped_qty": ["shipped qty", "shipped quantity", "qty shipped", "quantity", "outbound qty", "quantity shipped"],
    "tracking": ["tracking number", "tracking no", "awb", "tracking"],
    "shipped_date": ["shipped date", "ship date", "date shipped", "outbound time", "order shipped at"],
    "status": ["status", "fulfillment status", "order status"],
}

FIELD_LABELS = {
    "item": "Item number / SKU",
    "warehouse": "Warehouse",
    "qty": "Quantity",
    "available": "Available physical (on-hand)",
    "product_name": "Product name",
    "so_number": "Sales order number",
    "shopify_ref": "Shopify reference",
    "remarks": "Remarks",
    "bundle_item": "Bundle SKU",
    "shipped_qty": "Shipped qty",
    "tracking": "Tracking number",
    "shipped_date": "Shipped date",
    "status": "Status",
}

OPTIONAL_FIELDS = {"product_name", "remarks", "bundle_item", "status", "shopify_ref", "so_number"}


def load_uploaded_file(uploaded_file, candidates, widget_key, extra_optional=None):
    """Fully automatic: auto-picks sheet, header row, and column mapping by
    fuzzy match. Only surfaces UI when something required couldn't be
    auto-detected, or if the user opens the "fix detected columns" panel.
    Returns (df, col_map) or (None, None) if not ready yet."""
    if uploaded_file is None:
        return None, None

    file_bytes = uploaded_file.getvalue()
    filename = uploaded_file.name
    optional_fields = OPTIONAL_FIELDS | (extra_optional or set())

    sheets = list_sheets(file_bytes, filename)
    if sheets and len(sheets) > 1:
        sheet_name, guessed_header = pick_best_sheet(file_bytes, filename, sheets, candidates)
    else:
        sheet_name = sheets[0] if sheets else None
        raw_preview = read_raw_preview(file_bytes, filename, sheet_name=sheet_name)
        guessed_header = guess_header_row(raw_preview, candidates)

    df = load_table(file_bytes, filename, sheet_name=sheet_name, header_row=int(guessed_header))

    if has_sku_blocks(df.columns):
        df = unpivot_sku_blocks(df)
        st.info(
            f"Detected a repeated 'SKU 1 / SKU 2 / ...' wide layout — unpivoted to "
            f"one row per SKU line ({len(df)} lines)."
        )

    guesses = {field: fuzzy_match_column(df.columns, cand_list) for field, cand_list in candidates.items()}
    missing_required = [f for f in candidates if f not in optional_fields and guesses.get(f) is None]

    detected_bits = ", ".join(f"{FIELD_LABELS.get(f, f)} → '{v}'" for f, v in guesses.items() if v)
    st.caption(f"Loaded {len(df)} rows from '{sheet_name}', header row {guessed_header}. Detected: {detected_bits}")

    with st.expander(
        "Fix detected columns / sheet / header row" + (" — action needed" if missing_required else ""),
        expanded=bool(missing_required),
    ):
        if sheets and len(sheets) > 1:
            sheet_name = st.selectbox("Sheet", sheets, index=sheets.index(sheet_name), key=f"{widget_key}_sheet")
        raw_preview = read_raw_preview(file_bytes, filename, sheet_name=sheet_name)
        header_row = st.number_input(
            "Header row (0 = first row)", min_value=0, max_value=19,
            value=int(guessed_header), key=f"{widget_key}_header_row",
        )
        st.dataframe(raw_preview.astype(str), width='stretch')

        if sheet_name != (sheets[0] if sheets else None) or header_row != guessed_header:
            df = load_table(file_bytes, filename, sheet_name=sheet_name, header_row=int(header_row))
            if has_sku_blocks(df.columns):
                df = unpivot_sku_blocks(df)
            guesses = {field: fuzzy_match_column(df.columns, cand_list) for field, cand_list in candidates.items()}

        col_map = {}
        cols = st.columns(min(4, len(candidates)) or 1)
        for i, (field, cand_list) in enumerate(candidates.items()):
            guess = guesses.get(field)
            is_optional = field in optional_fields
            options = list(df.columns) + (["-- none --"] if is_optional else [])
            if not is_optional and guess is None:
                options = ["-- select --"] + options
            if guess is not None:
                default = guess
            elif is_optional:
                default = "-- none --"
            else:
                default = "-- select --"
            with cols[i % len(cols)]:
                choice = st.selectbox(
                    FIELD_LABELS.get(field, field), options,
                    index=options.index(default), key=f"{widget_key}_{field}",
                )
            col_map[field] = None if choice in ("-- none --", "-- select --") else choice

    missing_required = [f for f in candidates if f not in optional_fields and col_map.get(f) is None]
    if missing_required:
        st.error(
            "Missing required column(s) — open the panel above to pick them manually: "
            + ", ".join(FIELD_LABELS.get(f, f) for f in missing_required)
        )
        return df, None

    return df, col_map


def infer_facility(warehouses):
    for wh in warehouses:
        if str(wh).upper().startswith("USOPS-"):
            return "U001"
    return "H007"


def _style_task_a_row(row):
    if row["Item number"] == "TOTAL":
        return [""] * len(row)
    if row["To produce"] > 0:
        return ["background-color: #FFC7CE; color: #9C0006"] * len(row)
    return ["background-color: #C6EFCE; color: #006100"] * len(row)


def render_task_a():
    st.header("Task A — Production Requirement Report")
    st.write(
        "Compares requested quantity per SKU/warehouse against on-hand (+ on-order, if "
        "provided) inventory. To produce = MAX(Requested − On-hand − On-order, 0). Rows "
        "needing production are highlighted red; rows with To produce = 0 are green. "
        "Sorted with the largest shortfalls on top."
    )

    col1, col2, col3 = st.columns(3)
    with col1:
        st.subheader("1. Requested inventory file")
        st.caption("Requested qty per SKU for dispatched orders (Item number, Warehouse, Requested qty).")
        requested_file = st.file_uploader("Upload requested inventory", type=["xlsx", "xls", "csv"], key="a_requested")
        requested_df, requested_cols = load_uploaded_file(requested_file, TASK_A_REQUESTED_CANDIDATES, "a_req")

    with col2:
        st.subheader("2. D365 on-hand inventory export")
        st.caption("Item number, Warehouse, batch rows, Available physical.")
        onhand_file = st.file_uploader("Upload on-hand export", type=["xlsx", "xls", "csv"], key="a_onhand")
        onhand_df, onhand_cols = load_uploaded_file(onhand_file, TASK_A_ONHAND_CANDIDATES, "a_onh")

    with col3:
        st.subheader("3. (Optional) D365 on-order qty")
        st.caption("Incoming/in-production qty per SKU — added to on-hand so it isn't double-counted as a shortfall.")
        onorder_file = st.file_uploader("Upload on-order export", type=["xlsx", "xls", "csv"], key="a_onorder")
        onorder_df, onorder_cols = (None, None)
        if onorder_file is not None:
            onorder_df, onorder_cols = load_uploaded_file(onorder_file, TASK_A_ONORDER_CANDIDATES, "a_onor")

    if requested_df is None or onhand_df is None or requested_cols is None or onhand_cols is None:
        st.info("Upload the requested-inventory and on-hand files to continue (on-order is optional).")
        return
    if onorder_file is not None and onorder_cols is None:
        return  # column-mapping error already shown by load_uploaded_file

    filtered_requested_df = requested_df
    if requested_cols.get("remarks"):
        remark_col = requested_cols["remarks"]
        remark_values = sorted(requested_df[remark_col].dropna().astype(str).unique().tolist())
        default_selection = [v for v in remark_values if v == "IT - to rerun fulfillment"] or remark_values
        with st.expander(f"Remarks filter (defaulting to: {', '.join(default_selection)})"):
            chosen_remarks = st.multiselect(
                "Which Remarks values count as still needing production?",
                remark_values, default=default_selection, key="a_remarks_filter",
            )
        filtered_requested_df = requested_df[requested_df[remark_col].astype(str).isin(chosen_remarks)]

    show_all_rows = st.checkbox("Show all rows (highlight shortfalls) — uncheck to show only shortfall rows", value=True)

    per_wh, diagnostics = compute_production_requirement(
        filtered_requested_df, onhand_df, requested_cols, onhand_cols, show_all_rows=show_all_rows,
        onorder_df=onorder_df, onorder_cols=onorder_cols,
    )

    with st.expander("Summary / diagnostics"):
        st.json(diagnostics)

    if not per_wh:
        st.warning("No output rows produced — check the column mappings and Remarks filter above.")
        return

    facility = infer_facility(per_wh.keys())
    for wh, table in per_wh.items():
        st.write(f"**{wh}** — {len(table) - 1} SKU rows")
        row_colors = ["" if r["Item number"] == "TOTAL" else ("red" if r["To produce"] > 0 else "green") for _, r in table.iterrows()]
        xlsx_bytes = to_excel_bytes({wh: table}, row_colors={wh: row_colors})
        filename = f"{datetime.date.today().strftime('%Y%m%d')}_{wh}_Production_Requirement.xlsx"
        st.download_button(
            f"Download {wh} result (.xlsx)", data=xlsx_bytes, file_name=filename,
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            key=f"a_download_{wh}",
        )
        st.dataframe(table.style.apply(_style_task_a_row, axis=1), width='stretch')


def match_fulfillment_for_warehouse(so_subset, so_cols, ful_df, ful_cols):
    """Run the join+match logic for one (open-SO subset, fulfillment file) pair.
    Returns (per_sheet, diagnostics). Handles order-level fallback (no SKU
    column on the fulfillment side) the same way regardless of caller."""
    order_level_mode = ful_cols.get("item") is None

    so_key_item_col = None if order_level_mode else so_cols["item"]
    ful_key_item_col = None if order_level_mode else ful_cols["item"]

    # Both sides must use the SAME primary-key basis or their keys will never
    # line up — e.g. if the fulfillment report has no Sales order column at
    # all (order-level 3PL summaries usually don't), the open-SO side must
    # also fall back to Shopify reference, even though it has a real Sales
    # order column, otherwise nothing ever matches.
    can_use_so_number = bool(so_cols.get("so_number")) and bool(ful_cols.get("so_number"))
    so_number_for_so = so_cols.get("so_number") if can_use_so_number else None
    so_number_for_ful = ful_cols.get("so_number") if can_use_so_number else None

    so_work = so_subset.copy()
    so_work["__key"] = build_join_key(
        so_work, so_number_for_so, so_cols.get("shopify_ref"), so_key_item_col
    )
    ful_work = ful_df.copy()
    ful_work["__key"] = build_join_key(
        ful_work, so_number_for_ful, ful_cols.get("shopify_ref"), ful_key_item_col
    )

    if order_level_mode:
        PLACEHOLDER_ITEM = "(All SKUs — order-level match)"
        # dropna=False: pandas drops NaN-keyed groups by default, which would
        # silently vanish blank-warehouse orders instead of bucketing them as
        # "Unassigned" like the rest of this pipeline does.
        so_work = so_work.groupby(["__key", so_cols["warehouse"]], as_index=False, dropna=False)[so_cols["qty"]].sum()
        so_work["__item"] = PLACEHOLDER_ITEM
        ful_work["__item"] = PLACEHOLDER_ITEM
        item_col_for_so, item_col_for_ful = "__item", "__item"
    else:
        item_col_for_so, item_col_for_ful = so_cols["item"], ful_cols["item"]

    open_so_cols = {"key": "__key", "item": item_col_for_so, "warehouse": so_cols["warehouse"], "ordered_qty": so_cols["qty"]}
    compute_ful_cols = {
        "key": "__key", "item": item_col_for_ful, "shipped_qty": ful_cols["shipped_qty"],
        "tracking": ful_cols["tracking"], "shipped_date": ful_cols["shipped_date"],
    }
    if not order_level_mode and ful_cols.get("bundle_item"):
        compute_ful_cols["bundle_item"] = ful_cols["bundle_item"]
    if ful_cols.get("status"):
        compute_ful_cols["status"] = ful_cols["status"]

    return compute_fulfillment_check(so_work, ful_work, open_so_cols, compute_ful_cols)


def render_task_b():
    st.header("Task B — Fulfillment Check Report")
    st.write(
        "Joins open sales-order lines to warehouse fulfillment/shipped report(s). "
        "Per order: Shipped / Partially Shipped / Not Fulfilled."
    )

    col1, col2 = st.columns(2)
    with col1:
        st.subheader("1. D365 open sales order list")
        st.caption("Sales order number, Shopify reference, Item/SKU, Warehouse, Ordered qty.")
        so_file = st.file_uploader("Upload open sales order list", type=["xlsx", "xls", "csv"], key="b_so")
        so_df, so_cols = load_uploaded_file(so_file, TASK_B_OPEN_SO_CANDIDATES, "b_so")

    with col2:
        st.subheader("2. Warehouse fulfillment report(s)")
        st.caption(
            "Upload one file per warehouse if your reports come separately (e.g. "
            "a different WMS/3PL per warehouse) — or a single combined file."
        )
        fulfillment_files = st.file_uploader(
            "Upload warehouse fulfillment report(s)", type=["xlsx", "xls", "csv"],
            accept_multiple_files=True, key="b_fulfillment",
        )

    if so_df is None or so_cols is None or not fulfillment_files:
        st.info("Upload the open sales order list and at least one fulfillment report to continue.")
        return

    if not so_cols.get("so_number") and not so_cols.get("shopify_ref"):
        st.error("The open sales order list needs a Sales order number or a Shopify reference column to join on.")
        return

    # Blank warehouse becomes its own "Unassigned" bucket from here on, so it
    # flows through the same per-warehouse matching/uncovered-warehouse logic
    # as any real warehouse rather than being silently excluded by dropna().
    so_df = so_df.copy()
    blank_wh = so_df[so_cols["warehouse"]].isna() | (so_df[so_cols["warehouse"]].astype(str).str.strip() == "")
    so_df.loc[blank_wh, so_cols["warehouse"]] = "Unassigned"

    known_warehouses = sorted(so_df[so_cols["warehouse"]].astype(str).unique().tolist())
    multiple_files = len(fulfillment_files) > 1

    parsed = []
    for f in fulfillment_files:
        ctx = st.expander(f"📄 {f.name}", expanded=True) if multiple_files else st.container()
        with ctx:
            ful_df, ful_cols = load_uploaded_file(
                f, TASK_B_FULFILLMENT_CANDIDATES, f"b_ful_{f.file_id}", extra_optional={"item"}
            )
            if ful_df is None or ful_cols is None:
                continue
            if not ful_cols.get("so_number") and not ful_cols.get("shopify_ref"):
                st.error("This file needs a Sales order number or a Shopify reference column to join on.")
                continue
            if ful_cols.get("item") is None:
                st.info(
                    "No SKU column found — this looks like an order-level shipping summary "
                    "(no per-line detail). Matching will be done at the whole-order level."
                )

            guessed_wh = guess_warehouse_from_filename(f.name, known_warehouses)
            wh_options = ["All warehouses"] + known_warehouses
            default_wh = guessed_wh or "All warehouses"
            if multiple_files:
                assigned_wh = st.selectbox(
                    "Which warehouse is this report for?", wh_options,
                    index=wh_options.index(default_wh), key=f"b_ful_wh_{f.file_id}",
                )
            else:
                assigned_wh = default_wh
                if guessed_wh:
                    st.caption(f"Applies to: {assigned_wh} (detected from filename)")

            parsed.append({"name": f.name, "df": ful_df, "cols": ful_cols, "warehouse": assigned_wh})

    if not parsed:
        st.warning("No fulfillment report could be parsed — check the column mappings above.")
        return

    if multiple_files:
        assigned = [p["warehouse"] for p in parsed]
        if "All warehouses" in assigned:
            st.error(
                "When uploading multiple fulfillment reports, each must be assigned to a "
                "specific warehouse (not 'All warehouses') so they don't overlap."
            )
            return
        dupes = sorted({wh for wh in assigned if assigned.count(wh) > 1})
        if dupes:
            st.error(f"More than one report is assigned to: {', '.join(dupes)}. Each warehouse needs exactly one report.")
            return

    filtered_so_df = so_df
    if so_cols.get("remarks"):
        remark_col = so_cols["remarks"]
        remark_values = sorted(so_df[remark_col].dropna().astype(str).unique().tolist())
        default_selection = [
            v for v in remark_values
            if v in ("Ops - refund order", "Ops - to manually fulfil and adjust inventory")
        ] or remark_values
        with st.expander(f"Remarks filter (defaulting to: {', '.join(default_selection)})"):
            chosen_remarks = st.multiselect(
                "Which order lines should Task B cover?",
                remark_values, default=default_selection, key="b_remarks_filter",
            )
        filtered_so_df = so_df[so_df[remark_col].astype(str).isin(chosen_remarks)]

    combined_per_sheet = {}
    combined_diagnostics = {}
    covered_warehouses = set()
    for p in parsed:
        wh = p["warehouse"]
        if wh == "All warehouses":
            so_subset = filtered_so_df
        else:
            so_subset = filtered_so_df[filtered_so_df[so_cols["warehouse"]].astype(str) == wh]
            covered_warehouses.add(wh)
        if so_subset.empty:
            continue
        per_sheet, diagnostics = match_fulfillment_for_warehouse(so_subset, so_cols, p["df"], p["cols"])
        combined_per_sheet.update(per_sheet)
        combined_diagnostics[p["name"]] = diagnostics

    # Warehouses present in the open-SO data but with no matching uploaded
    # report: still show them (as fully Not Fulfilled) rather than silently
    # dropping them from the output.
    if multiple_files:
        uncovered = [wh for wh in known_warehouses if wh not in covered_warehouses]
        for wh in uncovered:
            so_subset = filtered_so_df[filtered_so_df[so_cols["warehouse"]].astype(str) == wh]
            if so_subset.empty:
                continue
            empty_ful_df = pd.DataFrame({so_cols["item"]: [], "__shipped_qty": [], "__tracking": [], "__shipped_date": []})
            empty_ful_cols = {
                "item": so_cols["item"], "shipped_qty": "__shipped_qty",
                "tracking": "__tracking", "shipped_date": "__shipped_date",
            }
            per_sheet, diagnostics = match_fulfillment_for_warehouse(so_subset, so_cols, empty_ful_df, empty_ful_cols)
            combined_per_sheet.update(per_sheet)
            combined_diagnostics[f"(no report uploaded for {wh})"] = diagnostics

    with st.expander("Summary / diagnostics (per uploaded file)"):
        st.json(combined_diagnostics)

    if not combined_per_sheet:
        st.warning("No output rows produced — check the column mappings above.")
        return

    row_colors = {}
    for name, table in combined_per_sheet.items():
        if "(Partially Shipped)" in name:
            row_colors[name] = ["amber" if v else None for v in (table["Outstanding qty"] > 0)]

    # One download button per warehouse, bundling all of that warehouse's
    # status sheets (Shipped/Partially Shipped/Not Fulfilled) into one file.
    sheets_by_warehouse = {}
    for name in combined_per_sheet:
        wh = name.split(" (")[0]
        sheets_by_warehouse.setdefault(wh, []).append(name)

    for wh, sheet_names in sheets_by_warehouse.items():
        wh_sheet_dict = {n: combined_per_sheet[n] for n in sheet_names}
        wh_row_colors = {n: row_colors[n] for n in sheet_names if n in row_colors}
        row_count = sum(len(t) for t in wh_sheet_dict.values())
        xlsx_bytes = to_excel_bytes(wh_sheet_dict, row_colors=wh_row_colors)
        filename = f"{datetime.date.today().strftime('%Y%m%d')}_{wh}_Fulfillment_Check.xlsx"
        st.download_button(
            f"Download {wh} result (.xlsx)", data=xlsx_bytes, file_name=filename,
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            key=f"b_download_{wh}",
        )
        st.write(f"**{wh}** — {row_count} total rows across {len(sheet_names)} status sheet(s)")

    for name, table in combined_per_sheet.items():
        st.write(f"**{name}** — {len(table)} rows")
        if "(Partially Shipped)" in name:
            mask = table["Outstanding qty"] > 0
            styled = table.style.apply(
                lambda row: ["background-color: #FFD966" if mask.loc[row.name] else "" for _ in row], axis=1
            )
            st.dataframe(styled, width='stretch')
        else:
            st.dataframe(table, width='stretch')


st.title("IM8 Open SO Checking Tool (Operations)")
st.caption("No data persists beyond this browser session.")

tab_a, tab_b = st.tabs(["Production Requirement (Task A)", "Fulfillment Check (Task B)"])
with tab_a:
    render_task_a()
with tab_b:
    render_task_b()
