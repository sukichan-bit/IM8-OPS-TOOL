// Mirrors tests/test_task_b_real_fulfillment.py: validates the JS port
// against the REAL OPS-WH02 (wide SKU-block) and OPS-WH03 (order-level-only)
// fulfillment reports.
const fs = require("fs");
const io = require("../js/io_utils");
const { computeFulfillmentCheck, matchFulfillmentForWarehouse, buildJoinKey } = require("../js/task_b");

const BASE = "C:/Users/suki.chan_prenetics/Desktop/Claude/im8-open-SO-fulfillment-checking-tools";

function readXlsx(path, sheetName, headerRow) {
  const bytes = fs.readFileSync(path);
  const wb = io.loadWorkbook(bytes, path);
  const sheet = sheetName || wb.SheetNames[0];
  const raw = io.sheetToRawRows(wb, sheet, null);
  return io.loadTableFromRawRows(raw, headerRow || 0);
}

const soPath = `${BASE}/samples/20260723 H007 Open SO (Jul22).xlsx`;
const soRows = readXlsx(soPath, "SO Status", 3);
const scope = soRows.filter((r) =>
  ["Ops - refund order", "Ops - to manually fulfil and adjust inventory"].includes(r["Remarks"])
);

console.log("=".repeat(70));
console.log("WH02 (per-SKU wide-block format)");
const wh02Path = `${BASE}/samples/20260701-20260723 OPS-WH02 Fulfillment Report.xlsx`;
const wh02Rows = readXlsx(wh02Path);
console.log("has SKU blocks:", io.hasSkuBlocks(Object.keys(wh02Rows[0])));
const wh02Long = io.unpivotSkuBlocks(wh02Rows);
console.log("unpivoted rows:", wh02Long.length);

const wh02Orders = new Set(wh02Long.map((r) => r["Reference order No./参考单号"]).filter(Boolean));
const soAtWh02 = soRows.filter((r) => r["Warehouse"] === "OPS-WH02");
const overlap = soAtWh02.filter((r) => wh02Orders.has(r["Sales order"]));
console.log("full SO Status rows at OPS-WH02:", soAtWh02.length, "| overlapping with WH02 report:", overlap.length);

const testSoKeys = buildJoinKey(overlap, "Sales order");
const testSo = overlap.map((r, i) => ({ ...r, key: testSoKeys[i] }));
const wh02Keys = buildJoinKey(wh02Long, "Reference order No./参考单号");
const wh02WithKey = wh02Long.map((r, i) => ({ ...r, key: wh02Keys[i] }));

const openSoCols = { key: "key", item: "Item number", warehouse: "Warehouse", ordered_qty: "Quantity" };
const fulCols = {
  key: "key", item: "SKU", shipped_qty: "Outbound Qty",
  tracking: "Tracking No./物流跟踪号", shipped_date: "OutboundTime/出库时间", status: "Status/状态",
};
const wh02Result = computeFulfillmentCheck(testSo, wh02WithKey, openSoCols, fulCols);
console.log("WH02 diagnostics:", JSON.stringify(wh02Result.diagnostics));
for (const [name, table] of Object.entries(wh02Result.perSheet)) console.log(`  ${name}: ${table.length} rows`);

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}
assert(wh02Result.diagnostics.orders > 0, "expected matched orders for WH02");
assert((wh02Result.diagnostics.status_breakdown["Shipped"] || 0) > 0, "expected some fully-shipped orders");

console.log("=".repeat(70));
console.log("Real Task B scope x WH02 report (no pre-filtering to overlap) — sanity distribution");
const scopeKeys = buildJoinKey(scope, "Sales order");
const scopeWithKey = scope.map((r, i) => ({
  ...r,
  key: scopeKeys[i],
  Warehouse: r["Warehouse"] == null ? "Unassigned" : r["Warehouse"],
}));
const scopeResult = computeFulfillmentCheck(scopeWithKey, wh02WithKey, openSoCols, fulCols);
console.log("diagnostics:", JSON.stringify(scopeResult.diagnostics));
for (const [name, table] of Object.entries(scopeResult.perSheet)) console.log(`  ${name}: ${table.length} rows`);

console.log("=".repeat(70));
console.log("WH03 (order-level-only format, no SKU column)");
const wh03Path = `${BASE}/samples/20260701-20260723 OPS-WH03 Fulfillment Report.xlsx`;
const wh03Rows = readXlsx(wh03Path, "data");
assert(!io.hasSkuBlocks(Object.keys(wh03Rows[0])), "WH03 should have no SKU blocks");
assert(io.fuzzyMatchColumn(Object.keys(wh03Rows[0]), ["sku", "item number", "item"]) == null, "WH03 should have no SKU column");

const wh03Orders = new Set(wh03Rows.map((r) => r["Order Number"]).filter(Boolean));
const soAtWh03 = soRows.filter((r) => wh03Orders.has(r["Shopify reference"]));
console.log("open_so rows matching a WH03 order number:", soAtWh03.length);
assert(soAtWh03.length > 0, "expected some real open-SO rows to match WH03 order numbers");

// so_number: "Sales order" here — this is what the real app auto-detects,
// since the open-SO file DOES have a real Sales order column even though
// WH03's fulfillment report doesn't. This exact combination is what exposed
// the join-key-alignment bug (see matchFulfillmentForWarehouse): without the
// fix, the open-SO side would key on Sales order while the fulfillment side
// is forced onto Shopify-reference, and nothing would ever match.
const soCols3 = { so_number: "Sales order", shopify_ref: "Shopify reference", item: "Item number", warehouse: "Warehouse", qty: "Quantity" };
const fulCols3 = { so_number: null, shopify_ref: "Order Number", item: null, shipped_qty: "Quantity Shipped", tracking: "Tracking Number", shipped_date: "Order Shipped At", status: "Order Status" };
const wh03Match = matchFulfillmentForWarehouse(soAtWh03, soCols3, wh03Rows, fulCols3);
console.log("WH03 diagnostics:", JSON.stringify(wh03Match.diagnostics));
for (const [name, table] of Object.entries(wh03Match.perSheet)) console.log(`  ${name}: ${table.length} rows`);
assert(wh03Match.diagnostics.orders === 1982, `expected 1982 orders, got ${wh03Match.diagnostics.orders}`);
assert(
  JSON.stringify(wh03Match.diagnostics.status_breakdown) === JSON.stringify({ Shipped: 1982 }),
  `expected all 1982 Shipped, got ${JSON.stringify(wh03Match.diagnostics.status_breakdown)}`
);
assert(wh03Match.perSheet["Unassigned (Shipped)"]?.length === 42, "expected an Unassigned (Shipped) sheet with 42 rows");
assert(wh03Match.perSheet["OPS-WH03 (Shipped)"]?.length === 1975, "expected an OPS-WH03 (Shipped) sheet with 1975 rows");

if (!ok) {
  console.error("\nREAL FULFILLMENT JS TEST FAILED");
  process.exit(1);
}
console.log("\nREAL FULFILLMENT JS TESTS PASSED");
