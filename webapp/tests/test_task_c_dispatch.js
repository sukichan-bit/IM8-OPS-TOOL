// Tests the 2-bucket dispatch check against real H007 data: SO Status
// (refund/manual-fulfil scope, standing in for the dedicated
// Refund_and_cancel_order export we don't have a real sample of) + the real
// WH02 fulfillment report.
const fs = require("fs");
const io = require("../js/io_utils");
const taskC = require("../js/task_c");

const BASE = "C:/Users/suki.chan_prenetics/Desktop/Claude/im8-open-SO-fulfillment-checking-tools";

function readXlsxRows(path, sheetName, headerRow) {
  const bytes = fs.readFileSync(path);
  const wb = io.loadWorkbook(bytes, path);
  const sheet = sheetName || wb.SheetNames[0];
  const raw = io.sheetToRawRows(wb, sheet, null);
  return io.loadTableFromRawRows(raw, headerRow || 0);
}

const soPath = `${BASE}/samples/20260723 H007 Open SO (Jul22).xlsx`;
const soRows = readXlsxRows(soPath, "SO Status", 3);
const scope = soRows.filter((r) =>
  ["Ops - refund order", "Ops - to manually fulfil and adjust inventory"].includes(r["Remarks"])
);
console.log("scope rows:", scope.length);

const { rows: backfilled, flagged } = taskC.backfillSerWarehouses(scope, "Sales order", "Warehouse");
console.log("flagged (no resolvable warehouse):", flagged.length);

// Only rows that DID resolve to a real warehouse can be warehouse-matched —
// the rest are a legitimate "needs manual warehouse resolution" bucket.
const resolvable = backfilled.filter((r) => !io.isExcelFilename && r["Warehouse"]); // keep real value check simple
const flaggedOrders = new Set(flagged.map((f) => f.salesOrder));
const matchable = backfilled.filter((r) => !flaggedOrders.has(r["Sales order"]));
console.log("matchable rows (resolved warehouse):", matchable.length);

const wh02Path = `${BASE}/samples/20260701-20260723 OPS-WH02 Fulfillment Report.xlsx`;
const wh02Raw = readXlsxRows(wh02Path);
const wh02Long = io.unpivotSkuBlocks(wh02Raw);

const refundedOnRows = readXlsxRows(soPath, "Refunded on", 2);
const actionsRaw = io.sheetToRawRows(io.loadWorkbook(fs.readFileSync(soPath), soPath), "Actions", null);
const resolveRefundDate = taskC.buildRefundDateResolver(refundedOnRows, { so: "Sales order", date: "Created date and time" }, actionsRaw);

const cols = { item: "Item number", warehouse: "Warehouse", qty: "Quantity", salesOrder: "Sales order", shopifyRef: "Shopify reference" };
const fulCols = {
  item: "SKU", shipped_qty: "Outbound Qty", tracking: "Tracking No./物流跟踪号",
  shipped_date: "OutboundTime/出库时间", status: "Status/状态", so_number: "Reference order No./参考单号",
};

const wh02Matchable = matchable.filter((r) => r["Warehouse"] === "OPS-WH02");
console.log("matchable rows at OPS-WH02:", wh02Matchable.length);

const { perSheet, diagnostics } = taskC.computeDispatchCheck(wh02Matchable, cols, wh02Long, fulCols, resolveRefundDate);
console.log("Sheet names:", Object.keys(perSheet));
console.log("Diagnostics:", JSON.stringify(diagnostics, null, 2));

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}

assert(Object.keys(perSheet).length > 0, "expected at least one output sheet");
assert(diagnostics.split_across_tabs.length === 0, `expected no orders split across tabs, got ${diagnostics.split_across_tabs}`);

for (const [name, rows] of Object.entries(perSheet)) {
  console.log(`  ${name}: ${rows.length} rows`);
  if (name.includes("Dispatched") && !name.includes("Not Dispatched")) {
    for (const r of rows) {
      if (taskC.normText(r["Item number"]).startsWith("im8-ser-")) {
        assert(r["Tracking number"] === "", `SER line should have blank tracking in dispatched order, got '${r["Tracking number"]}' for ${r["Sales order"]}`);
      }
      assert(/^\d{2}\/\d{2}\/\d{4}$/.test(r["Shipped date"]) || r["Shipped date"] === "", `Shipped date should be MM/DD/YYYY, got '${r["Shipped date"]}'`);
    }
  }
  if (name.includes("Not Dispatched")) {
    for (const r of rows) {
      assert(r["Refund Date"] !== undefined, "Not Dispatched rows should have a Refund Date field");
    }
  }
}

// ---- Order-level fulfillment report (no Sales-order / SKU columns) ----
// Real-world regression: the WH05 fulfillment report has no "Sales order" or
// item column at all (only Order Number / Shopify ref, at the order level).
// That forces matchFulfillmentForWarehouse's internal join key onto
// Shopify-reference alone (task_b.js's canUseSoNumber gate). computeDispatchCheck's
// OUTER re-keying step must reproduce that exact same key basis, or its
// perOrder.get(key) lookup silently misses every real match and every order
// shows as "Not Dispatched" even when the underlying engine found a real one.
const u001Path = `${BASE}/samples/20260730 U001 Open SO (Jul30).xlsx`;
const u001Wb = io.loadWorkbook(fs.readFileSync(u001Path), u001Path);
const u001RefundedOnRows = io.loadTableFromRawRows(io.sheetToRawRows(u001Wb, "Refund Date", null), 0);
const u001ActionsRaw = io.sheetToRawRows(u001Wb, "Action", null);
const u001Resolve = taskC.buildRefundDateResolver(u001RefundedOnRows, { so: "Sales order", date: "Created date and time" }, u001ActionsRaw);

const u001BatchPath = `${BASE}/samples/20260730 U001 Refund and Cancel order lines_TBC.xlsx`;
const u001BatchRows = readXlsxRows(u001BatchPath);
const u001Cols = { item: "Item number", warehouse: "Warehouse", qty: "Quantity", salesOrder: "Sales order", shopifyRef: "Shopify reference", productName: "Product name" };
const u001Wh05Rows = u001BatchRows.filter((r) => r["Warehouse"] === "USOPS-WH05");

const wh05Path = `${BASE}/samples/20260730 USOPS-WH05 fulfillment report.xlsx`;
const wh05Rows = readXlsxRows(wh05Path, "data");
// Mirrors the real column mapping: no Sales-order / item column, order-level only.
const wh05Cols = { item: null, shipped_qty: "Quantity Shipped", tracking: "Tracking Number", shipped_date: "Order Shipped At", status: "Order Status", shopify_ref: "Order Number", so_number: null };

const { rows: dispatchRows, diagnostics: u001Diag } = taskC.computeDispatchCheck(u001Wh05Rows, u001Cols, wh05Rows, wh05Cols, u001Resolve);
const dispatchedCount = dispatchRows.filter((r) => r.__dispatch_status === "Dispatched").length;
console.log("\nOrder-level fulfillment regression — status_breakdown:", JSON.stringify(u001Diag.status_breakdown), "outer Dispatched rows:", dispatchedCount);
const shippedOrders = u001Diag.status_breakdown["Shipped"] || 0;
assert(shippedOrders > 0, "expected at least one real 'Shipped' order in this dataset (sanity check on the fixture itself)");
assert(dispatchedCount > 0, "outer re-keying must surface the Shipped order(s) as Dispatched, not silently default everything to Not Dispatched");

if (!ok) {
  console.error("\nDISPATCH CHECK TEST FAILED");
  process.exit(1);
}
console.log("\nDISPATCH CHECK TEST PASSED");
