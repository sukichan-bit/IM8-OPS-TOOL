// Validates Task B's new D365 fulfillment-template generation for dispatched
// orders: reuses Task C's buildFulfillmentTemplateRows/buildBatchLookup, and
// specifically the line-level-shortfall safety check requested by ops — an
// order's overall status is a NETTED total across its non-service lines, so
// one line can be under-shipped while another is over-shipped enough that
// the order still nets to "Shipped" overall. That must be caught and
// excluded from the auto-generated template, not silently trusted.
const taskB = require("../js/task_b");
const taskC = require("../js/task_c");

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}

// ---- Synthetic case: order nets to "Shipped" overall but one line is short ----
const soRows = [
  { SO: "SO-1", Item: "IM8-FG-000001", Warehouse: "OPS-WH02", Qty: 3 }, // shipped 5 (over)
  { SO: "SO-1", Item: "IM8-FG-000002", Warehouse: "OPS-WH02", Qty: 3 }, // shipped 1 (under) -- real shortfall
  { SO: "SO-2", Item: "IM8-FG-000003", Warehouse: "OPS-WH02", Qty: 2 }, // shipped 2 (clean full match)
  { SO: "SO-3", Item: "IM8-SER-000005", Warehouse: "OPS-WH02", Qty: 1 }, // service line on a clean order
  { SO: "SO-3", Item: "IM8-FG-000004", Warehouse: "OPS-WH02", Qty: 1 },
];
const jul20 = new Date(Date.UTC(2026, 6, 20));
const jul21 = new Date(Date.UTC(2026, 6, 21));
const fulRows = [
  { Order: "SO-1", SKU: "IM8-FG-000001", Qty: 5, Tracking: "TRACK-1", Date: jul20 },
  { Order: "SO-1", SKU: "IM8-FG-000002", Qty: 1, Tracking: "TRACK-1", Date: jul20 },
  { Order: "SO-2", SKU: "IM8-FG-000003", Qty: 2, Tracking: "TRACK-2", Date: jul20 },
  { Order: "SO-3", SKU: "IM8-SER-000005", Qty: 1, Tracking: "TRACK-3", Date: jul21 },
  { Order: "SO-3", SKU: "IM8-FG-000004", Qty: 1, Tracking: "TRACK-3", Date: jul21 },
];

const openSoCols = { key: "SO", item: "Item", warehouse: "Warehouse", ordered_qty: "Qty" };
const fulCols = { key: "Order", item: "SKU", shipped_qty: "Qty", tracking: "Tracking", shipped_date: "Date" };
const { rows } = taskB.computeFulfillmentCheck(soRows, fulRows, openSoCols, fulCols);

const order1Rows = rows.filter((r) => r.key === "SO-1");
assert(order1Rows.every((r) => r.order_status === "Shipped"), "sanity check on the fixture: SO-1 must net to 'Shipped' overall despite the per-line shortfall (that's the exact scenario being guarded against)");
const shortLine = order1Rows.find((r) => r.item === "IM8-FG-000002");
assert(shortLine.outstanding_qty === 2, `expected the under-shipped line to have outstanding_qty 2 (3 ordered - 1 shipped), got ${shortLine.outstanding_qty}`);

// ---- Apply the same filter app.js's renderTaskBFulfillmentTemplate uses ----
const shippedRows = rows.filter((r) => r.order_status === "Shipped");
const lineShortfalls = shippedRows.filter((r) => !r.is_service && r.outstanding_qty > 0);
const flaggedKeys = new Set(lineShortfalls.map((r) => r.key));
assert(flaggedKeys.has("SO-1"), "SO-1 must be flagged and excluded from the auto-generated template");
assert(!flaggedKeys.has("SO-2") && !flaggedKeys.has("SO-3"), "SO-2/SO-3 (clean full matches) must NOT be flagged");

const templateRows = shippedRows.filter((r) => !flaggedKeys.has(r.key));
const templateKeys = new Set(templateRows.map((r) => r.key));
assert(!templateKeys.has("SO-1"), "SO-1 must not appear in the final template input at all");
assert(templateKeys.has("SO-2") && templateKeys.has("SO-3"), "SO-2/SO-3 must appear in the final template input");

// ---- Build the actual template rows (reusing Task C's builder) and check the SER line ----
const cols = { item: "item", salesOrder: "key", qty: "shipped_qty", warehouse: "warehouse" };
const batchLookup = new Map([["IM8-FG-000003|OPS-WH02", "BATCH-XYZ"]]);
const batchLookupFn = (item, wh) => batchLookup.get(`${item}|${wh}`) || "";
const { rows: unitRows, multiTrackingOrders } = taskC.buildFulfillmentTemplateRows(
  templateRows, cols,
  (row) => taskC.fmtMMDDYYYY(row.shipped_date),
  (row, isService) => (isService ? "" : row.tracking_number || ""),
  batchLookupFn
);

assert(multiTrackingOrders.length === 0, "no order here has multiple distinct tracking numbers");
assert(unitRows.length === 4, `expected 4 unit rows (SO-2 qty2 + SO-3's 2 lines at qty1 each), got ${unitRows.length}`);
const serUnit = unitRows.find((r) => r["SKU Number"] === "IM8-SER-000005");
assert(serUnit, "expected the SER line from SO-3 in the output");
assert(serUnit["Warehouse location"] === "Prenetics~~", `expected SER Warehouse location 'Prenetics~~', got '${serUnit["Warehouse location"]}'`);
assert(serUnit.AWB === "" && serUnit["Batch Number"] === "", "SER line must have blank AWB and Batch Number");
const fgUnit = unitRows.find((r) => r["SKU Number"] === "IM8-FG-000003");
assert(fgUnit["Warehouse location"] === "Prenetics~OPS-WH02~Primary", `expected FG Warehouse location, got '${fgUnit["Warehouse location"]}'`);
assert(fgUnit["Batch Number"] === "BATCH-XYZ", `expected batch lookup to resolve, got '${fgUnit["Batch Number"]}'`);
assert(fgUnit.AWB === "TRACK-2", `expected the tracking number carried through, got '${fgUnit.AWB}'`);
assert(fgUnit["Shipped date"] === "07/20/2026", `expected MM/DD/YYYY text date, got '${fgUnit["Shipped date"]}'`);

if (!ok) {
  console.error("\nTASK B DISPATCH TEMPLATE TEST FAILED");
  process.exit(1);
}
console.log("TASK B DISPATCH TEMPLATE TEST PASSED");
