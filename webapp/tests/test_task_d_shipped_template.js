// Validates buildShippedFulfillmentTemplate (Task B's D365 fulfillment
// template for Shipped orders) — per Fulfillment_check.md: sequential batch
// depletion per Item+Warehouse shared across the whole run (not an
// independent lookup per line), "Insufficient on-hand batch" flag when the
// pool runs dry, "Partial shipment" flag on an individual under-shipped line
// even when its order nets to "Shipped" overall, and SER lines blank
// AWB/Batch with "Prenetics~~".
const taskD = require("../js/task_d");

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}

// ---- Sequential depletion across two lines sharing the same Item+Warehouse ----
const onHandRows = [
  { Item: "IM8-FG-000001", Warehouse: "OPS-WH02", Available: 3, Batch: "BATCH-A" },
  { Item: "IM8-FG-000001", Warehouse: "OPS-WH02", Available: 2, Batch: "BATCH-B" },
];
const onHandCols = { item: "Item", warehouse: "Warehouse", available: "Available", batch: "Batch" };
const onHandIndex = taskD.buildOnHandIndex(onHandRows, onHandCols);

const shippedLines = [
  { item: "IM8-FG-000001", warehouse: "OPS-WH02", salesOrder: "SO-1", qty: 4, tracking: "TRACK-1", shippedDate: new Date(Date.UTC(2026, 6, 20)), isService: false, outstandingQty: 0, isMultiTracking: false },
  { item: "IM8-FG-000001", warehouse: "OPS-WH02", salesOrder: "SO-2", qty: 3, tracking: "TRACK-2", shippedDate: new Date(Date.UTC(2026, 6, 20)), isService: false, outstandingQty: 0, isMultiTracking: false },
];
const { table } = taskD.buildShippedFulfillmentTemplate(shippedLines, onHandIndex);
assert(table.length === 7, `expected 7 unit rows (4+3), got ${table.length}`);

const so1Rows = table.filter((r) => r["Order ID"] === "SO-1");
const so2Rows = table.filter((r) => r["Order ID"] === "SO-2");
// BATCH-A has only 3 available; SO-1 needs 4 -> must span BATCH-A (3) + BATCH-B (1).
const so1BatchA = so1Rows.filter((r) => r["Batch Number"] === "BATCH-A").length;
const so1BatchB = so1Rows.filter((r) => r["Batch Number"] === "BATCH-B").length;
assert(so1BatchA === 3 && so1BatchB === 1, `expected SO-1 to split 3 from BATCH-A + 1 from BATCH-B, got A=${so1BatchA} B=${so1BatchB}`);
// BATCH-B originally had 2 units; SO-1 already took 1, so only 1 remains for SO-2.
const so2BatchB = so2Rows.filter((r) => r["Batch Number"] === "BATCH-B").length;
const so2Insufficient = so2Rows.filter((r) => r.Flag.includes("Insufficient on-hand batch")).length;
assert(so2BatchB === 1, `expected SO-2 to get the 1 remaining unit from BATCH-B, got ${so2BatchB}`);
assert(so2Insufficient === 2, `expected 2 of SO-2's 3 units to be flagged Insufficient on-hand batch (pool exhausted), got ${so2Insufficient}`);
assert(so2Rows.filter((r) => r["Batch Number"] === "").length === 2, "the 2 insufficient units should have a blank Batch Number, not a guessed one");

// ---- Partial-shipment flag on an individual line, SER handling, not-batch-tracked ----
const shippedLines2 = [
  { item: "IM8-FG-000099", warehouse: "OPS-WH03", salesOrder: "SO-3", qty: 1, tracking: "TRACK-3", shippedDate: new Date(Date.UTC(2026, 6, 21)), isService: false, outstandingQty: 2, isMultiTracking: false }, // under-shipped line on an order that still nets "Shipped"
  { item: "IM8-SER-000005", warehouse: "OPS-WH03", salesOrder: "SO-3", qty: 1, tracking: "TRACK-3", shippedDate: new Date(Date.UTC(2026, 6, 21)), isService: true, outstandingQty: 0, isMultiTracking: false },
];
const { table: table2, multiTrackingOrders } = taskD.buildShippedFulfillmentTemplate(shippedLines2, onHandIndex);
const fgRow = table2.find((r) => r["SKU Number"] === "IM8-FG-000099");
assert(fgRow.Flag === "Partial shipment on this line — verify", `expected partial-shipment flag, got '${fgRow.Flag}'`);
assert(fgRow["Batch Number"] === "", "IM8-FG-000099 isn't in the on-hand index at all -> not batch-tracked, blank without an 'insufficient' flag");
const serRow = table2.find((r) => r["SKU Number"] === "IM8-SER-000005");
assert(serRow["Warehouse location"] === "Prenetics~~", `expected SER Warehouse location 'Prenetics~~', got '${serRow["Warehouse location"]}'`);
assert(serRow.AWB === "" && serRow["Batch Number"] === "", "SER line must have blank AWB and Batch Number");
assert(serRow.Flag === "", "the SER line itself has no shortfall (outstandingQty 0) so should carry no flag");
assert(multiTrackingOrders.length === 0, "no multi-tracking flag set in this fixture");

// ---- Multi-tracking flag passthrough ----
const shippedLines3 = [
  { item: "IM8-FG-000001", warehouse: "OPS-WH02", salesOrder: "SO-4", qty: 1, tracking: "TRACK-4", shippedDate: new Date(Date.UTC(2026, 6, 22)), isService: false, outstandingQty: 0, isMultiTracking: true },
];
const { multiTrackingOrders: mto3 } = taskD.buildShippedFulfillmentTemplate(shippedLines3, onHandIndex);
assert(mto3.includes("SO-4"), "SO-4 should be reported as a multi-tracking order");

if (!ok) {
  console.error("\nTASK D SHIPPED TEMPLATE TEST FAILED");
  process.exit(1);
}
console.log("TASK D SHIPPED TEMPLATE TEST PASSED");
