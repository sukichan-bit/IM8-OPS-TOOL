// Validates the 3-way dispatch status (Dispatched / Partially Dispatched /
// Not Dispatched) computeDispatchCheck now derives from task_b.js's own
// 3-way order_status (Shipped / Partially Shipped / Not Fulfilled) — a real
// user request: previously "Partially Shipped" orders were silently folded
// into "Dispatched", with no way to see/download them as their own group.
const taskC = require("../js/task_c");

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}

const cols = { item: "Item number", warehouse: "Warehouse", qty: "Quantity", salesOrder: "Sales order", shopifyRef: "Shopify reference" };
const refundCancelRows = [
  { "Sales order": "SO-FULL", "Item number": "IM8-FG-000001", Warehouse: "USOPS-WH04", Quantity: 5 },
  { "Sales order": "SO-PARTIAL", "Item number": "IM8-FG-000002", Warehouse: "USOPS-WH04", Quantity: 10 },
  { "Sales order": "SO-NONE", "Item number": "IM8-FG-000003", Warehouse: "USOPS-WH04", Quantity: 3 },
];
const fulfillmentRows = [
  // SO-FULL: fully shipped (5 of 5).
  { "Sales order": "SO-FULL", SKU: "IM8-FG-000001", "Shipped qty": 5, Tracking: "AWB-FULL", "Ship date": "2026-08-15" },
  // SO-PARTIAL: only 4 of 10 shipped.
  { "Sales order": "SO-PARTIAL", SKU: "IM8-FG-000002", "Shipped qty": 4, Tracking: "AWB-PARTIAL", "Ship date": "2026-08-16" },
  // SO-NONE never appears in the fulfillment report at all.
];
const fulCols = { item: "SKU", shipped_qty: "Shipped qty", tracking: "Tracking", shipped_date: "Ship date", so_number: "Sales order" };
const noResolver = () => ({ resolved: false, date: null });

const { rows, perSheet } = taskC.computeDispatchCheck(refundCancelRows, cols, fulfillmentRows, fulCols, noResolver);

const full = rows.find((r) => r["Sales order"] === "SO-FULL");
const partial = rows.find((r) => r["Sales order"] === "SO-PARTIAL");
const none = rows.find((r) => r["Sales order"] === "SO-NONE");

assert(full.__dispatch_status === "Dispatched", `fully-shipped order should be "Dispatched", got ${full.__dispatch_status}`);
assert(partial.__dispatch_status === "Partially Dispatched", `partially-shipped order should be its own "Partially Dispatched" status, got ${partial.__dispatch_status}`);
assert(none.__dispatch_status === "Not Dispatched", `unmatched order should be "Not Dispatched", got ${none.__dispatch_status}`);

// Partially Dispatched still carries a real shipped date/tracking, same as Dispatched.
assert(partial["Shipped date"] === "08/16/2026", `Partially Dispatched should still carry its real shipped date, got ${partial["Shipped date"]}`);
assert(partial["Tracking number"] === "AWB-PARTIAL", "Partially Dispatched should still carry its real tracking number");
// Not Dispatched still gets refund-date resolution attempted, not a shipped date.
assert(none["Shipped date"] === undefined, "Not Dispatched rows should never carry a Shipped date field");

// perSheet must produce a distinct "<warehouse> - Partially Dispatched" bucket.
assert(Object.keys(perSheet).includes("USOPS-WH04 - Partially Dispatched"), `expected a distinct Partially Dispatched sheet bucket, got sheets: ${JSON.stringify(Object.keys(perSheet))}`);
assert(perSheet["USOPS-WH04 - Dispatched"].length === 1, "the Dispatched bucket should only have the fully-shipped order");
assert(perSheet["USOPS-WH04 - Partially Dispatched"].length === 1, "the Partially Dispatched bucket should only have the partially-shipped order");
assert(perSheet["USOPS-WH04 - Not Dispatched"].length === 1, "the Not Dispatched bucket should only have the unmatched order");

if (!ok) {
  console.error("\nTASK C PARTIAL DISPATCH TEST FAILED");
  process.exit(1);
}
console.log("TASK C PARTIAL DISPATCH TEST PASSED");
