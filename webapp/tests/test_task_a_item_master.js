// Validates the "Verify item master" flag and the optional item-master
// name-backfill lookup (per production_shortfall_report_spec.md's Released-
// Items-master input and verify_item_master flag).
const taskA = require("../js/task_a");

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}

const requestedRows = [
  { Item: "IM8-FG-000001", Warehouse: "OPS-WH01", Qty: 10 }, // present in on-hand, has a name there
  { Item: "IM8-FG-000002", Warehouse: "OPS-WH01", Qty: 5 }, // absent from on-hand entirely -> flagged, name from item master
  { Item: "IM8-FG-000003", Warehouse: "OPS-WH01", Qty: 3 }, // absent from on-hand entirely, no item master entry either -> flagged, blank name
];
const onhandRows = [
  { Item: "IM8-FG-000001", Warehouse: "OPS-WH01", Available: 4, Name: "Widget One" },
];
const requestedCols = { item: "Item", warehouse: "Warehouse", qty: "Qty" };
const onhandCols = { item: "Item", warehouse: "Warehouse", available: "Available", product_name: "Name" };
const itemMaster = { "IM8-FG-000002": "Widget Two (from master)" };

const { perWarehouse } = taskA.computeProductionRequirement(requestedRows, onhandRows, requestedCols, onhandCols, true, null, null, itemMaster);
const table = perWarehouse["OPS-WH01"];

const row1 = table.find((r) => r["Item number"] === "IM8-FG-000001");
assert(row1["Product name"] === "Widget One", "item present in on-hand should use its own name");
assert(row1.Flag === "", "item present in on-hand (even with a real shortfall) should not be flagged");

const row2 = table.find((r) => r["Item number"] === "IM8-FG-000002");
assert(row2["Product name"] === "Widget Two (from master)", `expected name backfilled from item master, got '${row2["Product name"]}'`);
assert(row2.Flag === "Verify item master", "item absent from on-hand entirely must be flagged, even when the item master backfills its name");

const row3 = table.find((r) => r["Item number"] === "IM8-FG-000003");
assert(row3["Product name"] === "", "item absent from on-hand AND not in item master should have a blank name, not a guess");
assert(row3.Flag === "Verify item master", "item absent from on-hand entirely must be flagged");

// Known hardcoded name overrides (spec-documented / user-reported recurring
// gaps) apply even without any item master supplied.
const overrideRows = [
  { Item: "IM8-FG-000161", Warehouse: "USOPS-WH05", Qty: 1 },
  { Item: "IM8-FG-000166", Warehouse: "USOPS-WH05", Qty: 1 },
];
const overrideOnhand = []; // entirely absent from on-hand
const { perWarehouse: pw2 } = taskA.computeProductionRequirement(overrideRows, overrideOnhand, requestedCols, onhandCols, true);
const overrideRow = pw2["USOPS-WH05"].find((r) => r["Item number"] === "IM8-FG-000161");
assert(overrideRow["Product name"] === "Quarterly Subscription - Longevity Starter", `expected the known name override, got '${overrideRow["Product name"]}'`);
assert(overrideRow.Flag === "Verify item master", "the name override does not exempt the item from the on-hand-presence flag");

const overrideRow166 = pw2["USOPS-WH05"].find((r) => r["Item number"] === "IM8-FG-000166");
assert(overrideRow166["Product name"] === "Quarterly Subscription - Longevity Refill", `expected the known name override for IM8-FG-000166, got '${overrideRow166["Product name"]}'`);
assert(overrideRow166.Flag === "Verify item master", "the name override does not exempt IM8-FG-000166 from the on-hand-presence flag either");

if (!ok) {
  console.error("\nTASK A ITEM MASTER TEST FAILED");
  process.exit(1);
}
console.log("TASK A ITEM MASTER TEST PASSED");
