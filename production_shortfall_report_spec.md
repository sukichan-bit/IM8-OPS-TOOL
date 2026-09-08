# Production Shortfall / Rerun Report — Automation Spec

## Purpose

Ops (Suki, supply chain/inventory) generates a recurring report to answer:
**"For all open sales orders flagged for rerun fulfillment, which SKUs don't have
enough on-hand stock, and how much needs to be produced?"**

This doc specifies the full logic so it can be rebuilt as a standalone script
(CLI, notebook, or a small web tool) instead of doing it by hand in chat each time.

Two entities run this report on the same logic, different warehouse sets:

| Entity | Warehouses |
|---|---|
| **H007** (HK/GB/NL) | OPS-WH01, OPS-WH02, OPS-WH03 |
| **U001** (US) | USOPS-WH04, USOPS-WH05 |

---

## Inputs

The job takes **2–3 Excel files**, always supplied fresh per run:

### 1. Open SO workbook (required)
Filename pattern: `YYYYMMDD_<facility>_Open_SO*.xlsx` (e.g. `20260723_H007_Open_SO__Jul22_.xlsx`)

This is a large multi-tab D365 export. The tab to read is called **`Action`**
(U001) or **`Actions`** (H007) — tab name varies by facility, so match
case-insensitively on `action`.

That tab contains a **pre-built Excel PivotTable** near the top-left. Structure:

```
Row 1-2:  Title / filter labels (e.g. "Ops - to prep the inventory")
Row 3:    Pool               | D2C
Row 4:    Remarks            | IT - to rerun fulfillment
Row 5:    SO Status          | Open order
Row 6:    (blank)            | updated: <timestamp>
Row 7:    Sum of Quantity    | Column Labels ->
Row 8:    Row Labels         | <WH1>  | <WH2>  | <WH3>...   <- header row
Row 9..N: <Item number>      | qty1   | qty2   | qty3...
Row N+1:  Grand Total        | total1 | total2 | total3...
```

**Extraction rule:**
- Find the row containing `"Row Labels"` in column A — that's the header row.
  The cells to its right (until the first blank/None column) are the warehouse
  names, in order.
- Read down from the next row until you hit a row where column A == `"Grand Total"`.
  Every row in between is one SKU: `{item_number: {warehouse: qty, ...}}`.
- **Validate**: sum each warehouse column across all SKU rows and confirm it
  equals the value in the `Grand Total` row for that column. If it doesn't tie
  out, stop and flag — don't silently proceed.
- Blank/empty cells = 0 requested for that warehouse.

**Critical — do NOT use an alternative source on this same sheet:**
Some versions of this tab also have a second, more granular pivot further right
(columns ~P:U, keyed by `Shopify reference` + `Item number`). **Never
re-aggregate that one.** It has blank item-label rows for repeated Shopify
references, which silently drops SKUs when re-grouped (observed: dropped
IM8-FG-000011). Always use the first (Item × Warehouse) pivot described above.

### 2. On-hand inventory export (required)
Filename pattern: `YYYYMMDD_<facility>_on-hand*.xlsx` (e.g.
`20260724_H007_on-hand_report__as_of_1331_.xlsx`)

Flat table, one row per (Item, Warehouse, Batch). Relevant columns:

| Column | Use |
|---|---|
| `Item number` | join key |
| `Product name` | display name |
| `Warehouse` | join key |
| `Available physical` | on-hand qty — **sum** across all batch rows per Item+Warehouse |
| `On order` | incoming qty — see note below |

**Aggregation rule for on-hand:** `on_hand[item][wh] = sum(Available physical)`
across all rows matching that item+warehouse (batches). Never mix warehouses.

**Aggregation rule for on-order:** In every export observed so far, only **one**
batch row per (Item, Warehouse) ever carries a nonzero `On order` value — the
rest are 0. So `SUM()` is safe (no double-counting), but this has only been
verified empirically, not guaranteed by the source system. If a future export
shows multiple nonzero `On order` values for the same Item+Warehouse, treat
that as a red flag and ask the person before summing (could indicate double
counting or unrelated PO lines).

**Known data-quality issue:** the main on-hand export for **H007 / OPS-WH03**
has repeatedly failed to populate `On order` for the quarterly-subscription
bundle SKUs (the 2xx-range SKUs), showing 0 there even when real POs/production
are in flight. When this happens, a supplemental warehouse-specific "on-order
qty" export may be supplied separately (filename pattern
`YYYYMMDD_<facility>_<warehouse>_on-order_qty*.xlsx`, same column schema as the
main on-hand export). If supplied, its `On order` values **override** the main
export's values for that warehouse only; otherwise fall back to the main export
(likely 0/incomplete — note this in output).

**Timing caveat:** on-order data and on-hand data can come from different
snapshot times. If the on-hand snapshot is *newer* than the on-order snapshot,
some of that on-order quantity may have already been received and could already
be reflected in the higher on-hand figures (i.e. it may be double-counted
between the two columns). Always compare the two file timestamps and, if the
on-hand file is newer, flag the on-order/extra columns in the output as an
**upper bound pending a fresh on-order pull** rather than presenting them as
exact.

### 3. Released-items master (optional, for name backfill)
Filename pattern: `Released_Items_*.xlsx`. Used only to look up `Product name`
for SKUs missing from the on-hand export. If not supplied, fall back to
pulling `Product name` from the Open SO workbook's flat SO-list tab (e.g. `SO`
or `SO Status`), which has one row per order line with `Item number` +
`Product name` columns — take the first match.

---

## Standing SKU rules (apply regardless of facility)

- **Exclude** any `IM8-SER-*` item (service/shipping-charge lines — no physical
  inventory) and any SKU containing `9X7X4` or `10X8X5` (dimensional pallet
  SKUs) from requested/on-hand comparisons. (These generally don't appear in
  the rerun-fulfillment pivot anyway, but guard for it.)
- **SKU aliasing:** `IM8-FAKE-216` → `IM8-FG-000216`; `IM8-FAKE-215` →
  `IM8-FG-000215`. Apply this mapping before joining requested vs on-hand if
  either code appears.
- **Known name override:** `IM8-FG-000161` = "Quarterly Subscription -
  Longevity Starter" — historically absent from some on-hand exports; use this
  name without flagging if the SKU itself is otherwise present with data. Only
  flag-as-missing if the SKU has literally zero rows anywhere in the on-hand
  export.

---

## Calculation

For every SKU in the requested pivot, for every warehouse in that facility:

```
requested   = pivot value (0 if blank)
on_hand     = sum(Available physical) for that item+warehouse (0 if item absent entirely)
on_order    = sum(On order) for that item+warehouse, using warehouse-specific
              override file if supplied, else main export (0 if absent)
to_produce  = max(requested - on_hand, 0)
extra_on_order = max(on_order - to_produce, 0)
```

`extra_on_order` estimates incoming production/PO qty that is **not** needed to
cover the currently-known open-SO shortfall — i.e. potential over-ordering, or
simply stock arriving ahead of any currently visible demand.

**Row inclusion:** include a (SKU, warehouse) row in the output if
`to_produce > 0` **OR** `on_order > 0`. (A SKU with no shortfall and no on-order
activity contributes nothing to the report and is omitted — this differs from
an earlier, stricter version of the report that only showed `to_produce > 0`
rows; the current version also surfaces "no shortfall but stuff is already
being over-ordered" cases, since that's independently useful.)

**Item entirely absent from on-hand export:** treat `on_hand = 0`,
`on_order = 0` (unless a known name-override SKU, see above). Flag the row
(e.g. italic red text, or a boolean `verify_item_master: true` field) so ops
knows to check the item master rather than trusting a literal 0.

---

## Output

One workbook per run. Filename: `YYYYMMDD_<facility>_Production Short Fall for
rerun.xlsx` (YYYYMMDD = report/on-hand date, not necessarily today — use the
date embedded in the on-hand export filename/timestamp).

### Tab: `Summary`
- Title, report date, one-line description of sources used (include on-hand
  and on-order snapshot times if they differ).
- One row per warehouse: warehouse name, count of SKUs with `to_produce > 0`,
  sum of `to_produce`, count of SKUs with `extra_on_order > 0` (counted across
  **all** rows, not just the ones with zero shortfall).

### Tab per warehouse (e.g. `OPS-WH01`, `USOPS-WH04`, ...)
Columns, in order:

| Item number | Product name | Requested | On-hand available | On order | To produce | Extra on order |

- Sort: rows with `to_produce > 0` first (descending by `to_produce`), then
  rows with `to_produce == 0` but `extra_on_order > 0` (descending by
  `extra_on_order`).
- Highlight: amber fill for `to_produce > 0` rows; a distinct lighter fill
  (e.g. light blue) for the zero-shortfall/"extra" rows so they read as a
  different category at a glance.
- Red italic font on `Product name` for rows flagged "verify item master"
  (absent from on-hand export).
- Totals row at the bottom (sum of Requested, On-hand, On order, To produce,
  Extra on order).
- If a warehouse has zero rows to show, write a plain "No production needed…"
  sentence instead of an empty table.
- Small italic legend line(s) under the table explaining the color coding and
  the "verify item master" flag, repeated per tab (people often view one tab
  in isolation).

---

## Suggested implementation shape

A small Python script (this is what's been used interactively) is simplest:

```
pandas / openpyxl  -> read Open SO "Action(s)" pivot block + on-hand export(s)
                      + optional released-items master
                   -> build the per-warehouse dict structure above
                   -> write output workbook with openpyxl (styles, formulas,
                      column widths as described)
```

If a small **web/HTML front end** is wanted on top of this (e.g. drag-and-drop
the 2-3 files, click "Generate", download the result), the cleanest shape is:

- Keep all the parsing/calculation logic above in one pure-Python module with
  no I/O side effects beyond reading the given file paths and writing one
  output path — this makes it trivially reusable from a CLI, a notebook, or
  wrapped by a tiny local web server (e.g. Flask/FastAPI) that just handles
  file upload → call module → return the generated .xlsx for download.
- The facility (H007 vs U001) and its warehouse list should be a parameter,
  not hard-coded, since the same logic applies to both — the only difference
  is the warehouse names and how many there are.
- Tab-name matching for the Open SO sheet should be case-insensitive substring
  match on `"action"` since it's been seen as both `Action` and `Actions`.
- Treat the "pivot block extraction" (find `Row Labels`, read until `Grand
  Total`, validate against it) as its own small reusable function — it's the
  single most fragile/important piece of parsing in the whole pipeline.

## Open questions to confirm with Suki before automating fully

1. Is the `to_produce > 0 OR on_order > 0` inclusion rule still correct, or
   should the default (no explicit ask) revert to `to_produce > 0` only, with
   on-order shown as an optional flag/column rather than a reason to include a
   row?
2. Should the script auto-detect a supplemental per-warehouse on-order file by
   filename pattern, or should it always be passed explicitly as a third
   argument when present?
3. Any other facilities/warehouses expected beyond H007 and U001?
