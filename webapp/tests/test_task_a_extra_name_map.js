// Validates the auto-extracted Item -> Product name map (from a flat "SO"
// tab elsewhere in the same requested-inventory workbook) against a real
// file — the exact case a user reported: an item flagged "Verify item
// master" (zero rows in the on-hand export) showed a blank Product name,
// even though the SAME uploaded workbook has its real name on another tab.
const fs = require("fs");
const io = require("../js/io_utils");
const taskA = require("../js/task_a");

const path = "C:/Users/suki.chan_prenetics/Desktop/Claude/im8-open-SO-fulfillment-checking-tools/samples/20260804/20260803 U001 Open SO (Jul31).xlsx";

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}

const wb = io.loadWorkbook(fs.readFileSync(path), path);
const nameMap = taskA.extractItemNameMapFromWorkbook(wb);

assert(Object.keys(nameMap).length > 0, "expected to find at least one Item -> Product name mapping in this real workbook");
assert(
  nameMap["IM8-FG-000221"] === "Refill Beckham Stack Starter - Single-Serve Sachets - Mango",
  `expected IM8-FG-000221's real name from the "SO" tab, got ${JSON.stringify(nameMap["IM8-FG-000221"])}`
);

// ---- Full pipeline: this item has zero rows in a synthetic on-hand export (still legitimately flagged), but its name must now show ----
const requestedRows = [{ "Item number": "IM8-FG-000221", Warehouse: "USOPS-WH05", Quantity: 8 }];
const requestedCols = { item: "Item number", warehouse: "Warehouse", qty: "Quantity", remarks: null };
const onhandRows = [{ "Item number": "IM8-FG-000186", Warehouse: "USOPS-WH05", "Available physical": 5 }]; // a different item entirely
const onhandCols = { item: "Item number", warehouse: "Warehouse", qty: "Available physical", product_name: null };

const { perWarehouse } = taskA.computeProductionRequirement(
  requestedRows, onhandRows, requestedCols, onhandCols, true, null, null, {}, nameMap
);
const row = perWarehouse["USOPS-WH05"].find((r) => r["Item number"] === "IM8-FG-000221");
assert(row, "expected a row for IM8-FG-000221");
assert(row["Flag"] === "Verify item master", "this item genuinely has zero on-hand rows and must still be flagged — the name backfill must not silence a real data-completeness warning");
assert(row["Product name"] === "Refill Beckham Stack Starter - Single-Serve Sachets - Mango", `expected the real name to be backfilled even though flagged, got ${JSON.stringify(row["Product name"])}`);

// ---- Priority: an item PRESENT in on-hand (with its own name) must keep that name, not the extra map's ----
const onhandRows2 = [{ "Item number": "IM8-FG-000221", Warehouse: "USOPS-WH05", "Available physical": 3, "Product name": "On-hand's own name" }];
const onhandCols2 = { item: "Item number", warehouse: "Warehouse", qty: "Available physical", product_name: "Product name" };
const { perWarehouse: pw2 } = taskA.computeProductionRequirement(
  requestedRows, onhandRows2, requestedCols, onhandCols2, true, null, null, {}, nameMap
);
const row2 = pw2["USOPS-WH05"].find((r) => r["Item number"] === "IM8-FG-000221");
assert(row2["Product name"] === "On-hand's own name", "on-hand's own Product name must still win over the auto-extracted map when the item IS present in on-hand");
assert(row2["Flag"] === "", "an item present in on-hand must not be flagged");

if (!ok) {
  console.error("\nTASK A EXTRA NAME MAP TEST FAILED");
  process.exit(1);
}
console.log("TASK A EXTRA NAME MAP TEST PASSED");
