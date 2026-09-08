// Regression test for a real user-reported bug: Task B's fulfillment
// template generated 667 unit-rows against a real H007 rerun-lines file
// where the spec's own known-good example says the correct total is 348.
// Root cause: when a warehouse's fulfillment report has no SKU-level detail
// (Stord's order-level summary export — "Quantity Shipped" is a WHOLE
// SHOPIFY ORDER total, which can include SKUs outside the rerun scope),
// using shipped_qty as a rerun line's output quantity massively overstates
// it. The fix: for a line that isn't individually under-shipped
// (outstanding_qty <= 0 — order-level rows always satisfy this once
// "Shipped"), use ordered_qty instead, which is always safe once the order
// is already confirmed Shipped and doesn't inherit the order-level
// report's cross-SKU inflation.
const fs = require("fs");
const io = require("../js/io_utils");
const taskB = require("../js/task_b");

const BASE = "C:/Users/suki.chan_prenetics/Desktop/Claude/im8-open-SO-fulfillment-checking-tools/samples/20260805b";

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}

function loadWb(p) { return io.loadWorkbook(fs.readFileSync(p), p); }
function readTable(wb, sheet, hr) { return io.loadTableFromRawRows(io.sheetToRawRows(wb, sheet, null), hr || 0); }

// Mirrors app.js's renderTaskBFulfillmentTemplate qty-selection rule exactly.
function templateQty(r) {
  return r.outstanding_qty > 0 ? r.shipped_qty : r.ordered_qty;
}

const soWb = loadWb(`${BASE}/20260804 H007 Open SO (Jul31)_Rerun lines.xlsx`);
const soRows = readTable(soWb, "Sheet1", 0);
const openSoColMap = { item: "Item number", warehouse: "Warehouse", qty: "Quantity", so_number: "Sales order", shopify_ref: "Shopify reference" };

const wh02Wb = loadWb(`${BASE}/20260701-20260804 OPS-WH02 Fulfillment report.xlsx`);
const wh02Raw = readTable(wh02Wb, io.listSheets(wh02Wb)[0], 0);
const wh02Long = io.unpivotSkuBlocks(wh02Raw);
const wh02ColMap = {
  so_number: "Reference order No./参考单号", shopify_ref: "Platform order No./平台单号", item: "SKU",
  shipped_qty: "Outbound Qty", tracking: "Tracking No./物流跟踪号", shipped_date: "OutboundTime/出库时间", status: "Status/状态",
};

const wh03Wb = loadWb(`${BASE}/20260701-20260804 OPS-WH03 Fulfillment report.xlsx`);
const wh03Raw = readTable(wh03Wb, io.listSheets(wh03Wb)[0], 0);
const wh03ColMap = {
  so_number: null, shopify_ref: "Order Number", item: null,
  shipped_qty: "Quantity Shipped", tracking: "Tracking Number", shipped_date: "Order Shipped At", status: "Order Status",
};

const whCol = "Warehouse";
const wh02Subset = soRows.filter((r) => r[whCol] === "OPS-WH02");
const wh03Subset = soRows.filter((r) => r[whCol] === "OPS-WH03");
assert(wh02Subset.length === 74 && wh03Subset.length === 261, `fixture sanity check: expected 74/261 rerun lines, got ${wh02Subset.length}/${wh03Subset.length}`);

const r2 = taskB.matchFulfillmentForWarehouse(wh02Subset, openSoColMap, wh02Long, wh02ColMap);
const r3 = taskB.matchFulfillmentForWarehouse(wh03Subset, openSoColMap, wh03Raw, wh03ColMap);

assert(r2.diagnostics.orders === 48 && r2.diagnostics.status_breakdown.Shipped === 48, `expected all 48 WH02 orders Shipped, got ${JSON.stringify(r2.diagnostics)}`);
assert(r3.diagnostics.orders === 145 && r3.diagnostics.status_breakdown.Shipped === 144 && r3.diagnostics.status_breakdown["Not Fulfilled"] === 1, `expected 144 Shipped + 1 Not Fulfilled for WH03, got ${JSON.stringify(r3.diagnostics.status_breakdown)}`);

const shipped2 = r2.rows.filter((r) => r.order_status === "Shipped");
const shipped3 = r3.rows.filter((r) => r.order_status === "Shipped");

// The bug: naively using shipped_qty overstates WH03's total (order-level
// report inflation) — confirm that's still true of the raw data, so this
// test would catch a regression back to the old (wrong) behavior.
const wrongTotal = shipped2.reduce((s, r) => s + r.shipped_qty, 0) + shipped3.reduce((s, r) => s + r.shipped_qty, 0);
assert(wrongTotal === 667, `sanity check on the fixture: naive shipped_qty total should be 667 (the bug), got ${wrongTotal}`);

const correctTotal = shipped2.reduce((s, r) => s + templateQty(r), 0) + shipped3.reduce((s, r) => s + templateQty(r), 0);
assert(correctTotal === 348, `expected 348 total unit-rows (matches the spec's known-good example), got ${correctTotal}`);

const totalOrders = new Set([...shipped2, ...shipped3].map((r) => r.key)).size;
assert(totalOrders === 192, `expected 192 shipped orders (48+144), got ${totalOrders}`);

if (!ok) {
  console.error("\nTASK B ORDER-LEVEL QTY TEST FAILED");
  process.exit(1);
}
console.log("TASK B ORDER-LEVEL QTY TEST PASSED");
