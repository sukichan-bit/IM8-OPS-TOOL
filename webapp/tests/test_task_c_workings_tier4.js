// Validates the new tier-4 refund-date fallback (the flat "Workings" sheet's
// "R_Shipped Date" column, real Excel column AF) — added per a real user
// report: orders under "Ops - to cancel Order" (and related replacement-flow
// remarks) aren't covered by tiers 1-3 at all (those only search the Refund
// Date tab and the "Ops - refund order"/"Ops - to manually fulfil..."
// pivots), so they were falling through to unresolved even when the
// Workings sheet had a perfectly good real date.
const fs = require("fs");
const io = require("../js/io_utils");
const taskC = require("../js/task_c");

const BASE = "C:/Users/suki.chan_prenetics/Desktop/Claude/im8-open-SO-fulfillment-checking-tools/samples/20260803";
const path = `${BASE}/20260803 U001 Open SO (Jul31).xlsx`;

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}

const wb = io.loadWorkbook(fs.readFileSync(path), path);

// ---- Auto-detection of the Workings sheet's columns, mirroring app.js ----
const workingsRaw = io.sheetToRawRows(wb, "Workings", 20);
const g = io.guessHeaderRowAndScore(workingsRaw, { so_number: ["sales order"], date: ["r_shipped date"] });
const workingsRows = io.loadTableFromRawRows(io.sheetToRawRows(wb, "Workings", null), g.row);
const cols = Object.keys(workingsRows[0]);
const soCol = io.fuzzyMatchColumn(cols, ["sales order", "sales order number"]);
const dateCol = io.fuzzyMatchColumn(cols, ["r_shipped date", "replacement shipped date", "shipped date"]);
assert(soCol === "Sales order", `expected to detect the Sales order column, got '${soCol}'`);
assert(dateCol === "R_Shipped Date", `expected to detect the real R_Shipped Date column (Excel column AF), got '${dateCol}'`);

// ---- A real "Ops - to cancel Order" line's R_Shipped Date is a genuine placeholder here (order not yet processed in this snapshot) — must be excluded, not returned as a real date. ----
const placeholderRow = workingsRows.find((r) => r["Sales order"] === "U001-SO-786723");
assert(placeholderRow, "fixture sanity check: expected to find U001-SO-786723 in the Workings sheet");
assert(taskC.isPlaceholderDate(placeholderRow["R_Shipped Date"]), "expected this real row's R_Shipped Date to be recognized as the Excel-epoch-zero placeholder, not a real date");

const tier4Lookup = taskC.buildWorkingsShippedDateLookup(workingsRows, soCol, dateCol);
assert(!tier4Lookup.has("U001-SO-786723"), "the placeholder-dated order must NOT appear in the tier-4 lookup at all");

// ---- Full resolver: tier 4 must fire for an order with a genuine Workings date that tiers 1-3 don't cover ----
const refundedOnRows = io.loadTableFromRawRows(io.sheetToRawRows(wb, "Refund Date", null), 0);
const actionsRaw = io.sheetToRawRows(wb, "Action", null);

// Inject one synthetic real (non-placeholder) date onto a made-up SO, since
// this real file's snapshot predates any actual "Ops - to cancel Order"
// order's real ship date (they're all still placeholder-zero at this point).
const syntheticWorkingsRows = [
  ...workingsRows,
  { "Sales order": "U001-SO-999999", "R_Shipped Date": new Date(Date.UTC(2026, 7, 20)) }, // Aug 20 2026
];
const resolve = taskC.buildRefundDateResolver(refundedOnRows, { so: "Sales order", date: "Created date and time" }, actionsRaw, syntheticWorkingsRows, { so: "Sales order", date: "R_Shipped Date" });

const tier4Result = resolve("U001-SO-999999", null, null);
assert(tier4Result.resolved && tier4Result.tier === 4, `expected tier 4 resolution for the synthetic cancel-order case, got ${JSON.stringify(tier4Result)}`);
assert(taskC.fmtMMDDYYYY(tier4Result.date) === "08/20/2026", `expected 08/20/2026, got ${taskC.fmtMMDDYYYY(tier4Result.date)}`);

// ---- Priority: tiers 1-3 must still win over tier 4 when they resolve ----
const tier1SampleOrder = refundedOnRows[0];
const tier1WithWorkings = resolve(tier1SampleOrder["Sales order"], tier1SampleOrder["Shopify reference"], null);
assert(tier1WithWorkings.resolved && tier1WithWorkings.tier === 1, "tier 1 must still take priority over tier 4 when it resolves");

// ---- The genuinely-unresolvable order (placeholder-only) must fall through to tier 5 (unresolved), not silently show a wrong date ----
const stillUnresolved = resolve("U001-SO-786723", "IM8-1082229", "IM8-FG-000233");
assert(!stillUnresolved.resolved && stillUnresolved.tier === 5, `expected U001-SO-786723 to remain unresolved (tier 5) since its only Workings date is a placeholder, got ${JSON.stringify(stillUnresolved)}`);

if (!ok) {
  console.error("\nTASK C WORKINGS TIER 4 TEST FAILED");
  process.exit(1);
}
console.log("TASK C WORKINGS TIER 4 TEST PASSED");
