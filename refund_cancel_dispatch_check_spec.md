# Refund/Cancel Order Dispatch Check & Inventory Adjustment — Automation Spec

## Purpose

A recurring D365 ops workflow for orders flagged for refund or manual
cancellation ("Ops - refund order" and "Ops - to manual fulfill & adjust
inventory" in D365's Remarks field). These orders are supposed to have never
shipped — but occasionally one slips out the door before the refund is
processed. The job:

1. Confirm, per order, whether it actually shipped or not.
2. For anything that **did** ship: just fulfill it in D365 (it already left
   the warehouse; no inventory change needed, just paperwork).
3. For anything that **never** shipped: add the stock back to on-hand
   (inventory adjustment), then fulfill it in D365 to invoice/close it out.

This has been run for the **U001** (US) entity so far, warehouses
**USOPS-WH04** and **USOPS-WH05**. The same shape of problem could apply to
**H007** (OPS-WH01/02/03) if asked.

---

## Inputs

### 1. Open SO workbook (for refund-date lookups + pivot context)
Filename pattern: `YYYYMMDD_<facility>_Open_SO*.xlsx`

Two things are pulled from this file:

**a. The "Refund Date" tab** — a flat table with one row per order line,
columns including `Sales order`, `Item number`, and `Ship date` (this `Ship
date` column, in this specific tab, represents the **refund date**, not a
shipping date — naming is a D365 export quirk). Join on `Sales order` to get
a refund date per order.

**b. The `Action`/`Actions` tab's embedded pivot tables** — this sheet
contains *multiple* small pivot tables side by side, each with its own
filter block (`Remarks` = a category like `"Ops - refund order"`,
`"Ops - to manually fulfil and adjust inventory"`, `"IT - to rerun
fulfillment"`, etc.), not just one. When looking for a specific category,
search this sheet's Remarks filter cells rather than assuming a fixed column
range — the `Ops - to manually fulfil and adjust inventory` table has
historically included a `Replacement shipped at (UTC)` column carrying an
actual shipped timestamp for orders whose refund line hadn't been created in
D365 yet.

**Refund-date resolution order (fallback chain), per order:**
1. Look up in the "Refund Date" tab first.
2. If not found there, check the `Action(s)` tab's category-specific tables
   for a `Replacement shipped at (UTC)` value (or similarly named date field)
   — take the date portion.
3. If still not found, there may be a manually-noted date directly in one of
   the `Action(s)` tab's refund-category tables (sometimes flagged with a note
   like *"refund line not yet created in d365"*).
4. If none of the above resolve it, **stop and ask** rather than guessing —
   this has happened for real (4 out of 42 orders in one run needed steps 2–3
   above).

### 2. D365 open order lines for the refund/cancel batch
Filename pattern: `YYYYMMDD_<facility>_Refund_and_cancel_order.xlsx`

Flat table, one row per order line (already pre-filtered by whoever pulled it
in D365 to just the "Ops - refund order" / "Ops - to manual fulfill & adjust
inventory" categories — don't re-derive this filter from the Open SO workbook
pivots; treat this file as the source of truth for *which lines* are in
scope). Key columns: `Shopify reference`, `Sales order`, `Item number`,
`Product name`, `Quantity`, `Warehouse`, `Ship date`, `Status`.

**Important:** Service lines (`IM8-SER-*`) frequently have a **blank
Warehouse** in this file even though the rest of their order has a real
warehouse. Before splitting by warehouse, backfill: for each Sales order,
assign every line (including SER lines) the warehouse of that order's other,
non-blank line(s). Verify afterward that every Sales order maps to exactly
one warehouse and that no line is left with a blank warehouse — if any order
has lines pointing to two different real warehouses, or has no non-blank
warehouse at all, stop and flag it.

### 3. Warehouse fulfillment reports (one per warehouse, formats differ)

**USOPS-WH05 (Stord):** one row per **order** (not per line). Columns
include `Order Number` (= Shopify reference format `IM8-######`), `Order
Status` (`shipped`/`delivered`/`received`), `Order Shipped At`, `Tracking
Number`, `Quantity Requested`, `Quantity Shipped`. No SKU/line-item
breakdown — matching and "dispatched" determination can only happen at the
whole-order level here.

**USOPS-WH04 (Chinese WMS / GPS):** wide format, one row per outbound
shipment, up to 8 SKU slots per row (`SKU 1`...`SKU 8`). Key columns:
`Reference order No./参考单号` (= Sales order, `U001-SO-######`),
`Platform order No./平台单号` (= Shopify reference), `Status/状态` (dispatched
= `已出库`), `Tracking No./物流跟踪号`, `OutboundTime/出库时间` (shipped
timestamp).

**Matching logic:** for orders in a given warehouse, look up their Sales
order (WH04) or Shopify reference (WH05) in that warehouse's fulfillment
report. If found with a dispatched/shipped status → dispatched; capture
tracking number + shipped date. If not found at all → not dispatched. Given
the WH05 report's order-level (not line-level) granularity, treat dispatch
status as applying to the whole order, all lines together.

**Reality check from actual runs:** the overwhelming majority of these orders
never actually ship (that's the point of the category) — expect something
like 95%+ "not dispatched." Don't be surprised if only 1–2 orders out of
several dozen turn out to have shipped.

---

## Step 4 — Split into 4 tabs

Sheet names (Excel's 31-char sheet-name limit matters — keep names short,
e.g. `USOPS-WH04 - Dispatched`, not the longer phrasing a person might use in
prose):

- `<WH> - Dispatched`
- `<WH> - Not Dispatched`

For **dispatched** tabs: prepend two columns —
`Shipped date` (text, `MM/DD/YYYY`) and `Tracking number` — before the
original file's columns. Leave tracking number blank on SER lines within a
dispatched order (only the FG line(s) carry it).

For **not-dispatched** tabs: prepend one column — `Refund Date` (text,
`MM/DD/YYYY`, from the resolution chain above).

**Verification step (do this and report the result, don't just assume it
passes):** for every Sales order, confirm all of its lines landed in exactly
one tab. If any order is split across tabs, stop — that means the warehouse
backfill or the dispatch matching went wrong somewhere for that order.

---

## Step 5 — Dispatched orders: D365 fulfillment template only

No inventory adjustment needed (it already left the building). Ask the
person for the **on-hand inventory export** if not already provided, then
build the fulfillment template:

Columns (sheet `order`): `Shipped date` (text MM/DD/YYYY) · `Order ID`
(Sales order, not Shopify reference) · `AWB` (tracking number; blank for SER
lines) · `SKU Number` · `Warehouse location` (tilde-delimited
`Prenetics~<Warehouse>~Primary` for physical lines, `Prenetics~~` for SER
lines) · `Batch Number` (first row with `Available physical > 0` for that
Item+Warehouse in the on-hand export; blank if the item has no batch numbers
recorded at all, or for SER lines).

One row per **unit** (repeat by quantity — there's no quantity column).
Second sheet `serial number` (columns `Order ID`, `SKU Number`, `Serial
number`) stays empty unless serialized items are involved.

**Only one tracking number per order** is acceptable — if a warehouse export
somehow shows two different tracking numbers for the same order, flag it
rather than picking one silently.

---

## Step 6 — Not-dispatched orders: inventory adjustment journal

One file **per warehouse**. Within a warehouse, group by the refund-date
month:
- If every line's refund date falls in the same month **and that month is
  the current month**, use **today's date** for every journal line (not the
  individual refund dates) — the adjustment is being posted today regardless
  of when the refund was recorded.
- If refund dates span multiple months, split into **one file per month**,
  each dated appropriately (this hasn't come up yet in practice but the rule
  should be ready for it — ask the person what date to use for a past month's
  file if it's not obvious).

**Line-building rules:**
- Exclude `IM8-SER-*` lines entirely from the journal (no physical inventory
  impact).
- Exclude any line with non-positive quantity.
- Aggregate remaining lines **by Item number** (sum Quantity across all
  orders/lines for that item in that warehouse) — one journal row per item,
  not per order.
- Quantity is **positive** (adding cancelled stock back onto on-hand).

**The 22-column D365 journal template**, in this exact order:

```
Date, Item number, Product name, Manufacturer information, Style, Site,
Warehouse, Batch number, Location, CW quantity, CW unit, Quantity,
Unit quantity, Unit, Cost price, Cost amount, Batch disposition code,
Batch disposition status, Disposal reason, Disposal reason description,
Reject reason, Reject reason description
```

Field-by-field:
- `Date`: text, `MM/DD/YYYY`, per the monthly rule above.
- `Site`: `Prenetics` always, for every warehouse, every entity (this was a
  point of confusion once — it is **not** entity- or warehouse-specific).
- `Warehouse` / `Location`: the warehouse in question / `Primary` always.
- `Batch number`: pick any batch for that Item+Warehouse that has
  `Available physical > 0` in the on-hand export. Some items genuinely have
  **no batch number at all** in the on-hand export even with real on-hand
  qty (seen repeatedly for specific SKUs, e.g. IM8-FG-000029, -000143,
  -000145, -000146 in past U001 runs) — leave batch blank for those; don't
  invent one.
- `CW quantity`: `0` always.
- `Quantity`: positive, the aggregated qty for that item.
- `Unit quantity`: same value as `Quantity`.
- `Unit`: the item's unit of measure (`pcs`, `box`, `Set`, `Kit`, etc.) —
  pull from the aging report's `Inventory unit` column, or the on-hand
  export if the aging report doesn't have it.
- `Cost price`: **always** comes from the inventory aging report's *Average
  unit cost* column, matched by Item + Warehouse. Ask the person for the
  aging report if it hasn't been supplied — never leave cost blank and never
  guess it, for either entity (a past correction: don't assume US costs are
  left blank while HK/GB/NL ones aren't — both always use the aging report).
- `Cost amount`: `Quantity × Cost price`.
- If an item's own aging-report cost is `$0.00` or the item is missing from
  the aging report entirely, it's likely a subscription/bundle SKU — check
  for a known bundle cost composition (component SKUs × multiplier) before
  falling back to asking the person. Known compositions accumulate over time;
  don't assume a fixed list is complete — ask if an unfamiliar $0 bundle SKU
  shows up.
- Disposal/reject-reason columns: leave blank for this workflow (they're for
  damage/disposal journals, not refund add-backs).

---

## Step 7 — Not-dispatched orders: D365 fulfillment template (after the journal)

Same 6-column format as step 5's template (`Shipped date`, `Order ID`,
`AWB`, `SKU Number`, `Warehouse location`, `Batch Number`), same "one row per
unit" rule, but:

- `Shipped date` = each line's **refund date** (not today's date).
- `AWB` = the literal text `"Cancel order"` for FG lines; **blank** for SER
  lines (not "Cancel order" — this was corrected once before, easy to get
  wrong).
- `Batch Number` = **the exact batch used for that item in the step-6
  journal**, not a freshly re-derived batch. The journal and this fulfillment
  file are a matched pair; always build the journal first, then reuse its
  batch assignments here so the two documents are internally consistent.
- SER lines still get a row (one per unit) with `Prenetics~~` as the
  warehouse location and no batch — they're just excluded from the *journal*,
  not from the *fulfillment file*.
- Same one-tracking-per-order constraint as step 5 (trivially satisfied here
  since every FG line just gets the literal text "Cancel order").

---

## Data-quality gotchas worth hard-coding awareness of

- Sheet names >31 chars silently corrupt/warn in some Excel readers — keep
  generated tab names short.
- The Stord (WH05) fulfillment report has no line-item detail — don't design
  a matching algorithm that assumes SKU-level granularity there.
- SER lines' blank `Warehouse` field in the source file is expected, not a
  data error — always backfill from the sibling FG line(s) on the same
  order before splitting by warehouse.
- The "Refund Date" tab does not necessarily contain every order in the
  refund/cancel batch — always check for unmatched orders and use the
  fallback chain (Action tab's Replacement-shipped-at column, or a manual
  note) rather than assuming 100% coverage.
- Some FG items have on-hand quantity but **no batch number** in the on-hand
  export — this is a known, recurring data gap for specific SKUs, not a bug
  to "fix" by fabricating a batch.

## Suggested implementation shape

Same recommendation as the production-shortfall spec: keep parsing/matching/
journal-building logic as pure functions taking file paths in and an output
path out, parameterized by facility + warehouse list, so it's reusable
whether wrapped in a CLI, notebook, or small upload-and-download web tool.
The two fragile, high-value-to-get-right pieces to write as isolated,
independently testable functions are:
1. **Refund-date resolution** (the 3-step fallback chain above).
2. **Warehouse backfill for SER lines + the "one order → one tab" verification.**

## Open questions to confirm with Suki before automating fully

1. Should H007 (OPS-WH01/02/03) get this exact same treatment, or does its
   refund/cancel workflow differ in any way from U001's?
2. For the "refund month varies → one file per month" branch, what date
   should populate a *past* month's journal — the actual refund dates within
   that file, or some other convention? (Hasn't come up in practice yet.)
3. Is there a canonical, versioned list of bundle-SKU cost compositions
   somewhere, or should Claude Code keep asking per new bundle SKU
   encountered and accumulate its own list over time?
