// Regression test for a real user-reported gap: SER (service) lines never
// appear in ANY warehouse fulfillment report (they're a D365-only charge,
// not a physical pick/pack), so against a real per-SKU report they always
// look "under-shipped" (shipped_qty stays 0 forever) even when the rest of
// the order genuinely dispatched. The old logic used that false shortfall
// signal to select shipped_qty (0) as the line's output quantity, which
// silently dropped the SER line from the template entirely. Fix: SER lines
// always use their own ordered_qty and are never flagged, since the order's
// FG lines already being "Shipped" is the only signal that matters — an
// order whose FG lines never dispatched never reaches the shipped bucket at
// all, so its SER line is correctly excluded automatically.
//
// This mirrors app.js's renderTaskBFulfillmentTemplate mapping logic exactly
// (app.js itself can't run under Node) against the REAL WH02 line-level
// report, with one synthetic SER line injected onto a real, already-
// verified-Shipped order, plus one synthetic SER line on a Not-Fulfilled
// order to confirm the negative case.
const fs = require("fs");
const io = require("../js/io_utils");
const taskB = require("../js/task_b");
const taskD = require("../js/task_d");

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
function isServiceSku(sku) { return String(sku || "").toUpperCase().startsWith("IM8-SER-"); }

// Exact mirror of app.js's per-line qty/flag selection rule.
function mapToShippedLine(r, salesOrderId) {
  return {
    item: r.item,
    warehouse: r.warehouse,
    salesOrder: salesOrderId,
    qty: r.is_service ? r.ordered_qty : r.outstanding_qty > 0 ? r.shipped_qty : r.ordered_qty,
    tracking: r.tracking_number,
    shippedDate: r.shipped_date,
    isService: r.is_service,
    outstandingQty: r.is_service ? 0 : r.outstanding_qty,
    isMultiTracking: false,
  };
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

let wh02Subset = soRows.filter((r) => r["Warehouse"] === "OPS-WH02");

// Pick one real order to confirm is "Shipped" without the SER line first (fixture sanity).
const baselineResult = taskB.matchFulfillmentForWarehouse(wh02Subset, openSoColMap, wh02Long, wh02ColMap);
const shippedOrder = baselineResult.rows.find((r) => r.order_status === "Shipped");
assert(shippedOrder, "fixture sanity check: expected at least one real Shipped WH02 order");
const shippedSO = shippedOrder.salesOrder;
console.log("Using real Shipped order:", shippedSO);

// Pick one real Not-Fulfilled order too.
const notFulfilledOrder = baselineResult.rows.find((r) => r.order_status === "Not Fulfilled");
const notFulfilledSO = notFulfilledOrder ? notFulfilledOrder.salesOrder : null;
console.log("Using real Not-Fulfilled order:", notFulfilledSO);

// Inject a synthetic SER line onto both orders.
const withSerLines = [
  ...wh02Subset,
  { ...wh02Subset[0], "Sales order": shippedSO, "Item number": "IM8-SER-000005", "Quantity": 1, "Shopify reference": shippedOrder.key.startsWith("SHOPIFY::") ? null : undefined },
];
if (notFulfilledSO) {
  withSerLines.push({ ...wh02Subset[0], "Sales order": notFulfilledSO, "Item number": "IM8-SER-000005", "Quantity": 1 });
}

const result = taskB.matchFulfillmentForWarehouse(withSerLines, openSoColMap, wh02Long, wh02ColMap);

// Order-level status must be unaffected by the SER line (service lines excluded from status calc).
const shippedOrderRows = result.rows.filter((r) => r.salesOrder === shippedSO);
assert(shippedOrderRows.every((r) => r.order_status === "Shipped"), `expected ${shippedSO} to remain fully "Shipped" with the SER line added`);

const serRowOnShipped = shippedOrderRows.find((r) => r.is_service);
assert(serRowOnShipped, "expected the synthetic SER row to appear on the Shipped order");
assert(serRowOnShipped.outstanding_qty > 0, "sanity check on the fixture: the SER line should look under-shipped by the raw match (it never appears in any fulfillment report)");

const serLineMapped = mapToShippedLine(serRowOnShipped, shippedSO);
assert(serLineMapped.qty === serRowOnShipped.ordered_qty && serLineMapped.qty > 0, `expected the SER line's output qty to be its ordered_qty (${serRowOnShipped.ordered_qty}), got ${serLineMapped.qty}`);
assert(serLineMapped.outstandingQty === 0, "expected the SER line's outstandingQty to be forced to 0 so it isn't flagged");

const { table } = taskD.buildShippedFulfillmentTemplate([serLineMapped], null);
assert(table.length === serRowOnShipped.ordered_qty, `expected ${serRowOnShipped.ordered_qty} unit row(s) for the SER line, got ${table.length}`);
assert(table.every((r) => r["Warehouse location"] === "Prenetics~~"), "expected SER Warehouse location 'Prenetics~~'");
assert(table.every((r) => r.AWB === "" && r["Batch Number"] === ""), "expected SER AWB and Batch Number both blank");
assert(table.every((r) => r.Flag === ""), "expected the SER line to carry no flag now that outstandingQty is forced to 0");

// Negative case: SER line on a Not-Fulfilled order must never reach the shipped bucket at all.
if (notFulfilledSO) {
  const notFulfilledOrderRows = result.rows.filter((r) => r.salesOrder === notFulfilledSO);
  assert(notFulfilledOrderRows.every((r) => r.order_status !== "Shipped"), `expected ${notFulfilledSO} to remain Not Fulfilled`);
  const serRowOnNotFulfilled = notFulfilledOrderRows.find((r) => r.is_service);
  assert(serRowOnNotFulfilled && serRowOnNotFulfilled.order_status === "Not Fulfilled", "the SER row on the not-fulfilled order must itself carry order_status Not Fulfilled, so app.js's shippedRows filter excludes it automatically");
}

// Fully synthetic negative case (guaranteed Not-Fulfilled order, doesn't
// depend on one existing in the real fixture): an order whose only FG line
// never shipped at all, plus a SER line — the SER line must never reach the
// shipped bucket either, since the whole order's status is Not Fulfilled.
const synthSoRows = [
  { SO: "SO-UNSHIPPED", Item: "IM8-FG-000001", Warehouse: "OPS-WH02", Qty: 2 },
  { SO: "SO-UNSHIPPED", Item: "IM8-SER-000005", Warehouse: "OPS-WH02", Qty: 1 },
];
const synthFulRows = []; // nothing shipped at all for this order
const synthOpenSoCols = { key: "SO", item: "Item", warehouse: "Warehouse", ordered_qty: "Qty" };
const synthFulCols = { key: "Order", item: "SKU", shipped_qty: "Qty", tracking: "Tracking", shipped_date: "Date" };
const synthResult = taskB.computeFulfillmentCheck(synthSoRows, synthFulRows, synthOpenSoCols, synthFulCols);
const synthOrderRows = synthResult.rows.filter((r) => r.key === "SO-UNSHIPPED");
assert(synthOrderRows.every((r) => r.order_status === "Not Fulfilled"), "expected the fully-synthetic unshipped order (including its SER line) to be Not Fulfilled");
const synthShippedBucket = synthResult.rows.filter((r) => r.order_status === "Shipped");
assert(synthShippedBucket.length === 0, "the unshipped order's SER line must not leak into the Shipped bucket under any circumstance");

if (!ok) {
  console.error("\nTASK B SER INCLUSION TEST FAILED");
  process.exit(1);
}
console.log("TASK B SER INCLUSION TEST PASSED");
