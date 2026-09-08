// Mirrors the Python test: real on-hand file + SO Status (filtered to
// Remarks == "IT - to rerun fulfillment") as requested-qty input.
const io = require("../js/io_utils");
const { computeProductionRequirement } = require("../js/task_a");

const BASE = "C:/Users/suki.chan_prenetics/Desktop/Claude/im8-open-SO-fulfillment-checking-tools";

const fs = require("fs");

function readXlsxRows(path, sheetName) {
  const bytes = fs.readFileSync(path);
  const wb = io.loadWorkbook(bytes, path);
  const sheet = sheetName || wb.SheetNames[0];
  const raw = io.sheetToRawRows(wb, sheet, null);
  return io.loadTableFromRawRows(raw, 0);
}

const onhandRows = readXlsxRows(`${BASE}/samples/20260723 H007 on-hand (as of 1705).xlsx`);

const soPath = `${BASE}/samples/20260723 H007 Open SO (Jul22).xlsx`;
const soBytes = fs.readFileSync(soPath);
const soWb = io.loadWorkbook(soBytes, soPath);
const soRaw = io.sheetToRawRows(soWb, "SO Status", null);
const soRows = io.loadTableFromRawRows(soRaw, 3);

const requestedRows = soRows.filter((r) => r["Remarks"] === "IT - to rerun fulfillment");
console.log("requested rows (Remarks filter):", requestedRows.length);

const requestedCols = { item: "Item number", warehouse: "Warehouse", qty: "Quantity" };
const onhandCols = { item: "Item number", warehouse: "Warehouse", available: "Available physical", product_name: "Product name" };

const { perWarehouse, diagnostics } = computeProductionRequirement(requestedRows, onhandRows, requestedCols, onhandCols, true);
console.log("DIAGNOSTICS:", JSON.stringify(diagnostics));

for (const [wh, table] of Object.entries(perWarehouse)) {
  const totals = table[table.length - 1];
  console.log(`${wh}: ${table.length - 1} SKU rows, totals =`, JSON.stringify(totals));
}

// Cross-check against the known-correct Python results (already validated
// against the ops team's own manual pivot in the Python version).
const expected = {
  requested_rows_in: 4267,
  onhand_rows_in: 386,
  requested_excluded_sku_rows: 57,
  onhand_excluded_sku_rows: 0,
  requested_blank_warehouse_dropped: 3,
  output_rows: 69,
};
let ok = true;
for (const [k, v] of Object.entries(expected)) {
  if (diagnostics[k] !== v) {
    console.error(`MISMATCH: ${k} expected ${v}, got ${diagnostics[k]}`);
    ok = false;
  }
}
const expectedWarehouses = ["OPS-WH01", "OPS-WH02", "OPS-WH03"];
if (JSON.stringify(diagnostics.warehouses) !== JSON.stringify(expectedWarehouses)) {
  console.error("MISMATCH: warehouses", diagnostics.warehouses);
  ok = false;
}
const expectedTotals = {
  "OPS-WH01": { "Requested qty": 2, "On-hand qty": 0, "To produce": 2 },
  "OPS-WH02": { "Requested qty": 626, "On-hand qty": 55077, "To produce": 249 },
  "OPS-WH03": { "Requested qty": 3707, "On-hand qty": 57298, "To produce": 1742 },
};
for (const [wh, exp] of Object.entries(expectedTotals)) {
  const totals = perWarehouse[wh][perWarehouse[wh].length - 1];
  for (const [k, v] of Object.entries(exp)) {
    if (totals[k] !== v) {
      console.error(`MISMATCH in ${wh} totals.${k}: expected ${v}, got ${totals[k]}`);
      ok = false;
    }
  }
}

if (!ok) {
  console.error("\nTASK A JS TEST FAILED");
  process.exit(1);
}
console.log("\nTASK A JS TEST PASSED (matches Python results exactly)");
