// Validates the 3-tier refund-date resolver against the REAL H007 Open SO
// workbook (Refunded-on tab + Actions sheet's embedded pivots).
const fs = require("fs");
const io = require("../js/io_utils");
const taskC = require("../js/task_c");

const BASE = "C:/Users/suki.chan_prenetics/Desktop/Claude/im8-open-SO-fulfillment-checking-tools";
const path = `${BASE}/samples/20260723 H007 Open SO (Jul22).xlsx`;

const bytes = fs.readFileSync(path);
const wb = io.loadWorkbook(bytes, path);

const refundedOnRaw = io.sheetToRawRows(wb, "Refunded on", null);
const refundedOnRows = io.loadTableFromRawRows(refundedOnRaw, 2);
console.log("Refunded on tab rows:", refundedOnRows.length);

const actionsRaw = io.sheetToRawRows(wb, "Actions", null);
console.log("Actions raw rows:", actionsRaw.length);

// "Ship date" in this tab is NOT the refund date despite its name — verified
// against real data it runs consistently ~1 day earlier than "Created date
// and time" in the same row, which ops confirmed is the correct field.
const resolve = taskC.buildRefundDateResolver(refundedOnRows, { so: "Sales order", date: "Created date and time" }, actionsRaw);

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}

// Tier 1: a real order from the Refunded-on tab should resolve at tier 1.
const sampleOrder = refundedOnRows[0];
const t1 = resolve(sampleOrder["Sales order"], sampleOrder["Shopify reference"]);
console.log("Tier 1 test:", sampleOrder["Sales order"], "->", JSON.stringify(t1));
assert(t1.resolved && t1.tier === 1, "expected tier 1 resolution for a known Refunded-on order");
assert(String(t1.date) === String(sampleOrder["Created date and time"]), "tier 1 date should match Refunded-on tab's Created date and time");

// Tier 2: real order from the "manually fulfil" pivot block (from our direct
// inspection: IM8-940106 has R_shipped date 2026-07-16T23:14:37.999Z, FULFILLED).
const t2 = resolve("H007-SO-NONEXISTENT", "IM8-940106");
console.log("Tier 2 test:", JSON.stringify(t2));
assert(t2.resolved && t2.tier === 2, "expected tier 2 resolution for IM8-940106");

// Tier 5 (unresolved): an order/ref that appears nowhere should be
// unresolved, not guessed. (Tier 4 — the Workings sheet fallback — isn't
// wired up in this call since no workingsRows/workingsCols were passed.)
const t4 = resolve("H007-SO-DOES-NOT-EXIST", "IM8-DOES-NOT-EXIST");
console.log("Tier 5 test:", JSON.stringify(t4));
assert(!t4.resolved && t4.tier === 5, "expected unresolved (tier 5) for a completely unknown order");

// Sanity: run resolution across a sample of real orders and report the tier
// distribution, so we can see how often each tier is actually needed.
const wh03 = io.loadTableFromRawRows(io.sheetToRawRows(wb, "SO Status", null), 3);
const scope = wh03.filter((r) =>
  ["Ops - refund order", "Ops - to manually fulfil and adjust inventory"].includes(r["Remarks"])
);
const uniqueOrders = new Map();
for (const r of scope) {
  if (!uniqueOrders.has(r["Sales order"])) uniqueOrders.set(r["Sales order"], r["Shopify reference"]);
}
const tierCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
for (const [so, ref] of uniqueOrders.entries()) {
  const r = resolve(so, ref);
  tierCounts[r.tier]++;
}
console.log(`Tier distribution across ${uniqueOrders.size} real scope orders:`, tierCounts);

// ---- Tier 3 against the REAL U001 Open SO workbook ----
// This workbook's "Ops - refund order" pivot has its actual "Refund date"
// column sitting a few blank spacer columns after the warehouse-breakdown
// pivot's "Grand Total" — a real layout that previously broke header
// discovery (readPivotTable stopped at 2 consecutive blank headers and never
// reached "Refund date", so tier 3 silently never resolved anything, in ANY
// workbook shaped this way).
const u001Path = `${BASE}/samples/20260730 U001 Open SO (Jul30).xlsx`;
const u001Wb = io.loadWorkbook(fs.readFileSync(u001Path), u001Path);
const u001ActionsRaw = io.sheetToRawRows(u001Wb, "Action", null);
const u001RefundedOnRaw = io.loadTableFromRawRows(io.sheetToRawRows(u001Wb, "Refund Date", null), 0);
const u001Resolve = taskC.buildRefundDateResolver(u001RefundedOnRaw, { so: "Sales order", date: "Created date and time" }, u001ActionsRaw);

// Known real rows from the "Ops - refund order" pivot for ref IM8-1000068:
// item IM8-FG-000146 -> Refund date 07/01/2026, but items IM8-FG-000196 and
// IM8-SER-000004 on the SAME order -> Refund date 07/13/2026. Passing no
// Sales order (so tier 1 can't shortcut it) forces tier 2/3 item-level
// resolution to be exercised directly.
const tier3ItemA = u001Resolve(null, "IM8-1000068", "IM8-FG-000146");
const tier3ItemB = u001Resolve(null, "IM8-1000068", "IM8-FG-000196");
console.log("Tier 3 item-level test A (FG-000146):", JSON.stringify(tier3ItemA));
console.log("Tier 3 item-level test B (FG-000196):", JSON.stringify(tier3ItemB));
assert(tier3ItemA.resolved && tier3ItemA.tier === 3, "expected tier 3 resolution for IM8-1000068/IM8-FG-000146");
assert(taskC.fmtMMDDYYYY(tier3ItemA.date) === "07/01/2026", `expected 07/01/2026 for FG-000146, got ${taskC.fmtMMDDYYYY(tier3ItemA.date)}`);
assert(tier3ItemB.resolved && tier3ItemB.tier === 3, "expected tier 3 resolution for IM8-1000068/IM8-FG-000196");
assert(taskC.fmtMMDDYYYY(tier3ItemB.date) === "07/13/2026", `expected 07/13/2026 for FG-000196, got ${taskC.fmtMMDDYYYY(tier3ItemB.date)}`);
assert(tier3ItemA.date.getTime() !== tier3ItemB.date.getTime(), "different items on the same order with different real refund dates must not collapse to one date");

// A ref-only fallback (unknown item) should still resolve via tier 3 rather
// than going unresolved, using the first row found for that reference.
const tier3RefOnly = u001Resolve(null, "IM8-1000068", "IM8-SOME-UNKNOWN-SKU");
assert(tier3RefOnly.resolved && tier3RefOnly.tier === 3, "expected ref-only tier 3 fallback when the exact item isn't in the pivot");

// ---- Regression: tier 1 must use "Created date and time", not "Ship date" ----
// Real user report: order U001-SO-795997 / IM8-1095641 landed in the wrong
// (earlier) month's Step 6 journal. Root cause: "Ship date" in this tab is
// NOT the refund date despite its name — checked across 50+ real rows in two
// separate exports, it's consistently ~1 day earlier than "Created date and
// time" in the same row. This order is the clearest real example: Ship date
// = 07/31/2026 but Created date and time = 08/01/2026 (confirmed correct by
// ops), which independently agrees with tier 3's own "Refund date" pivot.
const aug3Path = `${BASE}/samples/20260803/20260803 U001 Open SO (Jul31).xlsx`;
const aug3Wb = io.loadWorkbook(fs.readFileSync(aug3Path), aug3Path);
const aug3RefundedOnRows = io.loadTableFromRawRows(io.sheetToRawRows(aug3Wb, "Refund Date", null), 0);
const aug3ActionsRaw = io.sheetToRawRows(aug3Wb, "Action", null);
const aug3Resolve = taskC.buildRefundDateResolver(aug3RefundedOnRows, { so: "Sales order", date: "Created date and time" }, aug3ActionsRaw);

const regressionRow = aug3RefundedOnRows.find((r) => r["Sales order"] === "U001-SO-795997");
assert(regressionRow, "expected to find U001-SO-795997 in the Aug 3 Refund Date tab (fixture check)");
assert(taskC.fmtMMDDYYYY(regressionRow["Ship date"]) === "07/31/2026", "fixture check: Ship date should still be 07/31/2026 (the wrong field)");
assert(taskC.fmtMMDDYYYY(regressionRow["Created date and time"]) === "08/01/2026", "fixture check: Created date and time should be 08/01/2026 (the correct field)");

const regressionResolved = aug3Resolve("U001-SO-795997", "IM8-1095641", "IM8-FG-000143");
console.log("\nRegression test (U001-SO-795997 / IM8-1095641):", JSON.stringify(regressionResolved), "->", taskC.fmtMMDDYYYY(regressionResolved.date));
assert(regressionResolved.resolved && regressionResolved.tier === 1, "expected tier 1 resolution for U001-SO-795997");
assert(taskC.fmtMMDDYYYY(regressionResolved.date) === "08/01/2026", `expected refund date 08/01/2026 (not 07/31/2026), got ${taskC.fmtMMDDYYYY(regressionResolved.date)}`);
assert(taskC.monthKey(regressionResolved.date) === "2026-08", `expected this order to land in the 2026-08 journal, got ${taskC.monthKey(regressionResolved.date)}`);

if (!ok) {
  console.error("\nREFUND DATE RESOLVER TEST FAILED");
  process.exit(1);
}
console.log("\nREFUND DATE RESOLVER TEST PASSED");
