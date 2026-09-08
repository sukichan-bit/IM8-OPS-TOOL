// Validates the Task A requested-qty pivot extraction (Action/Actions tab)
// against a REAL user-reported bug: the flat "SO" sheet, filtered by
// Remarks="IT - to rerun fulfillment" and summed, gave IM8-FG-000161 a
// requested qty of 33 at USOPS-WH05 — but the correct, ops-confirmed
// reference report (20260804_U001_Production_Short_Fall_for_rerun.xlsx) says
// 9. The authoritative source is the pre-built Item x Warehouse PivotTable
// embedded in the "Action" tab (per production_shortfall_report_spec.md),
// not a re-derivation from the raw SO-line sheet.
const fs = require("fs");
const io = require("../js/io_utils");
const taskA = require("../js/task_a");

const BASE = "C:/Users/suki.chan_prenetics/Desktop/Claude/im8-open-SO-fulfillment-checking-tools/samples/20260804";

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}

const soPath = `${BASE}/20260803 U001 Open SO (Jul31).xlsx`;
const soWb = io.loadWorkbook(fs.readFileSync(soPath), soPath);
const actionRaw = io.sheetToRawRows(soWb, "Action", null);

const pivot = taskA.extractItemWarehousePivot(actionRaw);
assert(pivot != null, "expected a pivot to be found in the Action tab");
assert(pivot.warehouses.length === 2 && pivot.warehouses.includes("USOPS-WH04") && pivot.warehouses.includes("USOPS-WH05"), `expected warehouses USOPS-WH04/05, got ${JSON.stringify(pivot.warehouses)}`);
assert(pivot.validation.mismatches.length === 0, `expected Grand Total validation to pass, got mismatches: ${JSON.stringify(pivot.validation.mismatches)}`);

const item161 = pivot.items.find((it) => it.item === "IM8-FG-000161");
assert(item161, "expected IM8-FG-000161 in the pivot");
assert(item161.values["USOPS-WH05"] === 9, `expected 9 (matching the real reference report), got ${item161.values["USOPS-WH05"]}`);
assert(!item161.values["USOPS-WH04"], "IM8-FG-000161 should have no WH04 demand (blank cell -> 0)");

// The OLD (wrong) approach — flatten the raw "SO" sheet by Remarks and sum —
// must NOT be what's used; confirm it actually gives a different (larger)
// number here, so this regression test would have caught the real bug.
const flatRows = io.loadTableFromRawRows(io.sheetToRawRows(soWb, "SO", null), 2).filter((r) => r["Remarks"] === "IT - to rerun fulfillment");
const flatSum161Wh05 = flatRows.filter((r) => r["Item number"] === "IM8-FG-000161" && r["Warehouse"] === "USOPS-WH05").reduce((s, r) => s + (typeof r["Quantity"] === "number" ? r["Quantity"] : 0), 0);
assert(flatSum161Wh05 === 33, `sanity check on the fixture: flat-sheet sum should be 33 (the wrong number), got ${flatSum161Wh05}`);
assert(flatSum161Wh05 !== item161.values["USOPS-WH05"], "the flat-sheet sum and the pivot value must differ here — that's the whole bug");

// ---- End-to-end: pivot -> flat rows -> computeProductionRequirement must match the real reference report ----
const flatRequested = taskA.pivotToFlatRequestedRows(pivot);
const onhandPath = `${BASE}/20260804 U001 on-hand report (as of 1158).xlsx`;
const onhandWb = io.loadWorkbook(fs.readFileSync(onhandPath), onhandPath);
const onhandRows = io.loadTableFromRawRows(io.sheetToRawRows(onhandWb, "Sheet1", null), 0);

const requestedCols = { item: "Item number", warehouse: "Warehouse", qty: "Quantity" };
const onhandCols = { item: "Item number", warehouse: "Warehouse", available: "Available physical", product_name: "Product name" };
const { perWarehouse } = taskA.computeProductionRequirement(flatRequested, onhandRows, requestedCols, onhandCols, false);

const wh05Table = perWarehouse["USOPS-WH05"];
const wh05Total = wh05Table.find((r) => r["Item number"] === "TOTAL");
console.log("WH05 totals (showAllRows=false, matching the reference report's shortfall-only rows):", wh05Total);
assert(wh05Total["Requested qty"] === 545, `expected Requested qty 545 (reference report total), got ${wh05Total["Requested qty"]}`);
assert(wh05Total["On-hand qty"] === 135, `expected On-hand qty 135, got ${wh05Total["On-hand qty"]}`);
assert(wh05Total["To produce"] === 410, `expected To produce 410, got ${wh05Total["To produce"]}`);
assert(wh05Table.length - 1 === 19, `expected 19 SKU rows (matching the reference report), got ${wh05Table.length - 1}`);

const wh04Table = perWarehouse["USOPS-WH04"];
const wh04Total = wh04Table.find((r) => r["Item number"] === "TOTAL");
assert(wh04Total["Requested qty"] === 1, `expected WH04 Requested qty 1, got ${wh04Total["Requested qty"]}`);
assert(wh04Total["To produce"] === 1, `expected WH04 To produce 1, got ${wh04Total["To produce"]}`);

// Spot-check a specific SKU/row against the reference report exactly.
const row233 = wh05Table.find((r) => r["Item number"] === "IM8-FG-000233");
assert(row233["Requested qty"] === 192 && row233["On-hand qty"] === 73 && row233["To produce"] === 119, `expected IM8-FG-000233 (192, 73, 119), got (${row233["Requested qty"]}, ${row233["On-hand qty"]}, ${row233["To produce"]})`);

if (!ok) {
  console.error("\nTASK A PIVOT TEST FAILED");
  process.exit(1);
}
console.log("\nTASK A PIVOT TEST PASSED");
