// Mirrors the Python on-order synthetic test: same real requested/on-hand
// data, plus a synthetic on-order file for two items at OPS-WH03.
const fs = require("fs");
const io = require("../js/io_utils");
const { computeProductionRequirement } = require("../js/task_a");

const BASE = "C:/Users/suki.chan_prenetics/Desktop/Claude/im8-open-SO-fulfillment-checking-tools";

function readXlsxRows(path, sheetName, headerRow) {
  const bytes = fs.readFileSync(path);
  const wb = io.loadWorkbook(bytes, path);
  const sheet = sheetName || wb.SheetNames[0];
  const raw = io.sheetToRawRows(wb, sheet, null);
  return io.loadTableFromRawRows(raw, headerRow || 0);
}

const onhandRows = readXlsxRows(`${BASE}/samples/20260723 H007 on-hand (as of 1705).xlsx`);
const soRows = readXlsxRows(`${BASE}/samples/20260723 H007 Open SO (Jul22).xlsx`, "SO Status", 3);
const requestedRows = soRows.filter((r) => r["Remarks"] === "IT - to rerun fulfillment");

const requestedCols = { item: "Item number", warehouse: "Warehouse", qty: "Quantity" };
const onhandCols = { item: "Item number", warehouse: "Warehouse", available: "Available physical", product_name: "Product name" };

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}

// 1. Regression: no on-order -> same as before, no "On-order qty" column.
const noOnorder = computeProductionRequirement(requestedRows, onhandRows, requestedCols, onhandCols, true);
assert(noOnorder.diagnostics.output_rows === 69, `expected 69 output rows, got ${noOnorder.diagnostics.output_rows}`);
assert(!("On-order qty" in noOnorder.perWarehouse["OPS-WH03"][0]), "should not have On-order qty column when omitted");
console.log("Regression OK (no on-order):", JSON.stringify(noOnorder.diagnostics));

// 2. With synthetic on-order rows.
const onorderRows = [
  { "Item number": "IM8-FG-000242", Warehouse: "OPS-WH03", "On order qty": 500 },
  { "Item number": "IM8-FG-000233", Warehouse: "OPS-WH03", "On order qty": 50 },
];
const onorderCols = { item: "Item number", warehouse: "Warehouse", qty: "On order qty" };
const withOnorder = computeProductionRequirement(requestedRows, onhandRows, requestedCols, onhandCols, true, onorderRows, onorderCols);
console.log("With on-order diagnostics:", JSON.stringify(withOnorder.diagnostics));

const wh03 = withOnorder.perWarehouse["OPS-WH03"];
const row242 = wh03.find((r) => r["Item number"] === "IM8-FG-000242");
console.log("IM8-FG-000242:", JSON.stringify(row242));
assert(row242["On-order qty"] === 500, `expected On-order qty 500, got ${row242["On-order qty"]}`);
assert(row242["To produce"] === 408, `expected To produce 408 (908 requested - 0 on-hand - 500 on-order), got ${row242["To produce"]}`);

const row233 = wh03.find((r) => r["Item number"] === "IM8-FG-000233");
assert(row233["To produce"] === 144, `expected To produce 144, got ${row233["To produce"]}`);

const totals = wh03[wh03.length - 1];
assert(totals["Item number"] === "TOTAL" && "On-order qty" in totals, "totals row should include On-order qty");

if (!ok) {
  console.error("\nTASK A ON-ORDER JS TEST FAILED");
  process.exit(1);
}
console.log("\nTASK A ON-ORDER JS TEST PASSED (matches Python results exactly)");
