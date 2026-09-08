# Prenetics Ops Tool — Build Spec for Claude Code

## Context
Internal tool for the Prenetics operations team. ERP is Microsoft Dynamics 365 (D365).
Two entities:
- H007 (HK/GB/NL): warehouses OPS-WH01, OPS-WH02, OPS-WH03
- U001 (US): warehouses USOPS-WH04, USOPS-WH05

Goal: build a simple internal web app (recommend Streamlit for v1) where any team
member can upload input files and download a computed Excel output. Two independent
tools/tabs in the app: "Production Requirement" (Task A) and "Fulfillment Check" (Task B).

Tech stack suggestion: Python, pandas + openpyxl for Excel I/O, Streamlit for UI.
Keep the two tools as separate pages/modes in the same app, sharing a common
"read uploaded Excel/CSV into DataFrame" utility.

---

## Task A — Production Requirement Report

### Inputs (user uploads two files)
1. **Requested inventory file** — requested qty per SKU for dispatched orders.
   Expected columns (confirm exact headers against a real sample, but conceptually):
   Item number / SKU, Warehouse, Requested qty. May need aggregation if the source
   file is at order-line grain (multiple rows per SKU+warehouse) — sum requested qty
   grouped by (Item number, Warehouse) before comparing.
2. **D365 on-hand inventory export** — columns include Item number, Warehouse, batch
   number, Available Physical qty (or similar). IMPORTANT: sum "Available Physical"
   across all batch rows per (Item number, Warehouse) before comparing — never mix
   warehouses when summing, and never compare against a single batch row.

### Logic
- Join requested-qty and on-hand data on (Item number, Warehouse).
- To produce = MAX(Requested qty − On-hand qty, 0)
- **Only include rows where To produce > 0** in the final output (per the user's
  current spec — confirm this each time since a richer "show all rows, highlight
  shortfalls" mode was used in a related manual workflow; ask the user which
  behavior they want if unclear).
- Exclude: service items (SKUs starting `IM8-SER-`) and dimensional pallet SKUs
  (containing `9X7X4` or `10X8X5`) if present in the input.
- SKU aliasing: map `IM8-FAKE-216` → `IM8-FG-000216`, `IM8-FAKE-215` → `IM8-FG-000215`
  before matching.

### Output
- Single Excel file.
- **One tab per warehouse.**
- Columns: Item number, Product name (if available — otherwise omit or leave blank;
  don't block on a missing product-name master), Requested qty, On-hand qty,
  To produce.
- Sort by To produce descending (largest shortfall first) within each tab.
- Add a totals row at the bottom of each tab.
- File name convention: `YYYYMMDD_<facility>_Production_Requirement.xlsx`
  (facility = H007 or U001, date = report generation date).

---

## Task B — Fulfillment Check Report

### Inputs (user uploads two files)
1. **D365 open sales order list** — includes Sales order number (format
   `H007-SO-######` or `U001-SO-######`), and/or Shopify-style reference
   (`IM8-######`), Item/SKU, Warehouse, Ordered qty.
2. **Warehouse fulfillment report** — per-warehouse export showing what has
   actually shipped: Sales order number or reference, SKU, Shipped qty,
   Tracking number (AWB), Shipped date. Note: some warehouse systems export in
   Chinese (e.g. 已出庫 = "dispatched") — normalize status fields to English
   before processing.

### Matching logic
- Primary join key: Sales order number. If not present/reliable, fall back to
  Shopify reference + Item Number as the join key (match against both a SKU
  column and a Bundle SKU column if the fulfillment report has one — bundle-aware
  matching can recover lines that wouldn't match on SKU alone).
- For each sales order, compare ordered lines vs. shipped lines:
  - **All lines fully shipped** → status = Shipped
  - **Some lines shipped, some not (or partial qty on a line)** → status =
    Partially Shipped
  - **No lines shipped** → status = Not Fulfilled
- For shipped lines: carry Tracking number and Shipped date onto the output row.
- One tracking number per sales order max in most cases; if a source file has
  multiple tracking numbers for one order, use the first and flag the row
  (e.g. a note/comment or a flag column) for manual verification rather than
  silently dropping the second.
- Exclude service lines (`IM8-SER-*`) from qty-shortfall calculations, but they
  can still appear informationally if present in the source (their tracking/date
  can inherit from the associated FG line on the same order if needed).

### Output
- Single Excel file.
- **One tab per warehouse × status combination**, named exactly like:
  - `OPS-WH02 (Shipped)`
  - `OPS-WH03 (Shipped)`
  - `OPS-WH02 (Partially Shipped)`
  - `OPS-WH03 (Partially Shipped)`
  - `OPS-WH02 (Not Fulfilled)`
  - `OPS-WH03 (Not Fulfilled)`
  - (extend pattern for any other warehouse present in the data, e.g. USOPS-WH04/05)
- Columns: Sales order number, SKU, Ordered qty, Shipped qty, Tracking number,
  Shipped date, Outstanding qty (Ordered − Shipped).
- On the **Partially Shipped** tabs: highlight (e.g. amber fill) any row where
  Outstanding qty > 0, so the gap is visible at a glance.
- File name convention: `YYYYMMDD_<facility>_Fulfillment_Check.xlsx`.

---

## Cross-cutting rules (apply to both tools)

- SKU normalization: `IM8-FAKE-216` → `IM8-FG-000216`, `IM8-FAKE-215` → `IM8-FG-000215`.
- Always exclude `IM8-SER-*` service items and dimensional pallet SKUs
  (`9X7X4`, `10X8X5`) from quantity calculations unless a task explicitly needs them.
- Never sum on-hand quantities across warehouses — always group by
  (Item number, Warehouse) at minimum.
- Sales order number formats: `H007-SO-######` (HK/GB/NL entity) or
  `U001-SO-######` (US entity). Shopify references: `IM8-######`.
- Some source files (Chinese WMS at OPS-WH02, GPS reports at WH04) use Chinese
  status fields — the app should normalize/translate known status strings
  (e.g. 已出庫 → "Dispatched") rather than fail silently on non-English input.

## App requirements (Claude Code build notes)
- Two upload slots per tool, clearly labeled with what each file should contain.
- Validate uploaded files have the expected columns before processing; show a
  clear error (not a stack trace) if a required column is missing.
- Show a preview/summary (row counts, warehouses detected) before generating
  the output, so users can sanity-check before downloading.
- Output: downloadable .xlsx via a "Download result" button.
- No data should persist on a shared server beyond the session unless the team
  explicitly wants a history/audit log — ask before building that in, since it
  affects hosting choice (plain Streamlit vs. one with a database).
- Keep the column-name matching a little fuzzy (case-insensitive, trims
  whitespace) since real-world exports won't always match a fixed header exactly.
