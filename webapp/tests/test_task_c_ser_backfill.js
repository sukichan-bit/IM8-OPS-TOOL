// Validates SER warehouse backfill against a synthetic dataset matching the
// spec's described pattern exactly: SER lines blank, sibling FG lines real.
// (Real SO Status data has a different, more severe blank-warehouse pattern —
// see test output below — since it isn't the dedicated Refund_and_cancel_order
// export the spec describes; we don't have a real sample of that file.)
const taskC = require("../js/task_c");

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}

const rows = [
  // Normal case: SER blank, FG line has real warehouse -> SER backfilled.
  { "Sales order": "SO-1", "Item number": "IM8-FG-000011", Warehouse: "OPS-WH01" },
  { "Sales order": "SO-1", "Item number": "IM8-SER-000005", Warehouse: "" },
  // Multiple FG lines agreeing -> still backfills cleanly.
  { "Sales order": "SO-2", "Item number": "IM8-FG-000011", Warehouse: "OPS-WH02" },
  { "Sales order": "SO-2", "Item number": "IM8-FG-000012", Warehouse: "OPS-WH02" },
  { "Sales order": "SO-2", "Item number": "IM8-SER-000005", Warehouse: null },
  // Conflict: two different real warehouses on the same order -> flagged.
  { "Sales order": "SO-3", "Item number": "IM8-FG-000011", Warehouse: "OPS-WH01" },
  { "Sales order": "SO-3", "Item number": "IM8-FG-000012", Warehouse: "OPS-WH03" },
  // No real warehouse anywhere on the order -> flagged.
  { "Sales order": "SO-4", "Item number": "IM8-SER-000005", Warehouse: "" },
];

const { rows: out, flagged } = taskC.backfillSerWarehouses(rows, "Sales order", "Warehouse");

const so1Ser = out.find((r) => r["Sales order"] === "SO-1" && r["Item number"] === "IM8-SER-000005");
assert(so1Ser["Warehouse"] === "OPS-WH01", "SO-1 SER line should backfill to OPS-WH01");

const so2Ser = out.find((r) => r["Sales order"] === "SO-2" && r["Item number"] === "IM8-SER-000005");
assert(so2Ser["Warehouse"] === "OPS-WH02", "SO-2 SER line should backfill to OPS-WH02");

assert(flagged.length === 2, `expected 2 flagged orders, got ${flagged.length}`);
const so3Flag = flagged.find((f) => f.salesOrder === "SO-3");
assert(so3Flag && so3Flag.issue === "conflicting_warehouse", "SO-3 should be flagged as conflicting_warehouse");
assert(
  so3Flag.warehouses.includes("OPS-WH01") && so3Flag.warehouses.includes("OPS-WH03"),
  "SO-3 flag should list both conflicting warehouses"
);
const so4Flag = flagged.find((f) => f.salesOrder === "SO-4");
assert(so4Flag && so4Flag.issue === "no_warehouse", "SO-4 should be flagged as no_warehouse");

if (!ok) {
  console.error("\nSER BACKFILL SYNTHETIC TEST FAILED");
  process.exit(1);
}
console.log("SER BACKFILL SYNTHETIC TEST PASSED");
