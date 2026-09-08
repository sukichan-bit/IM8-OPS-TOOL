// Regression test for a real user-reported bug: in order-level match mode
// (fulfillment report has no SKU/Sales-order column — e.g. Stord's summary
// export), the D365 fulfillment template showed the internal join key
// ("SHOPIFY::IM8-XXXXXXX") as Order ID instead of the real D365 Sales order
// number, and a placeholder ("(All SKUs — order-level match)") as SKU Number
// instead of the real per-SKU items from the open-SO rerun lines.
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

const soWb = loadWb(`${BASE}/20260804 H007 Open SO (Jul31)_Rerun lines.xlsx`);
const soRows = readTable(soWb, "Sheet1", 0);
const openSoColMap = { item: "Item number", warehouse: "Warehouse", qty: "Quantity", so_number: "Sales order", shopify_ref: "Shopify reference" };

const wh03Wb = loadWb(`${BASE}/20260701-20260804 OPS-WH03 Fulfillment report.xlsx`);
const wh03Raw = readTable(wh03Wb, io.listSheets(wh03Wb)[0], 0);
const wh03ColMap = {
  so_number: null, shopify_ref: "Order Number", item: null,
  shipped_qty: "Quantity Shipped", tracking: "Tracking Number", shipped_date: "Order Shipped At", status: "Order Status",
};

const wh03Subset = soRows.filter((r) => r["Warehouse"] === "OPS-WH03");
const r3 = taskB.matchFulfillmentForWarehouse(wh03Subset, openSoColMap, wh03Raw, wh03ColMap);
const shipped3 = r3.rows.filter((r) => r.order_status === "Shipped");

assert(shipped3.length > 0, "fixture sanity check: expected some Shipped WH03 orders");

// ---- Order ID must be the real D365 Sales order, never the join key ----
const stillShopifyKeyed = shipped3.filter((r) => String(r.salesOrder || "").startsWith("SHOPIFY::"));
assert(stillShopifyKeyed.length === 0, `expected every shipped row's salesOrder to be a real D365 SO number, but ${stillShopifyKeyed.length} still show the internal join key`);
assert(shipped3.every((r) => /^H007-SO-\d+$/.test(r.salesOrder)), "every shipped WH03 row's salesOrder must match the D365 format H007-SO-######");

// ---- Item must be the real per-SKU rerun lines, never the placeholder ----
const stillPlaceholder = shipped3.filter((r) => r.item === "(All SKUs — order-level match)" && (!r.originalLines || !r.originalLines.length));
assert(stillPlaceholder.length === 0, `expected every order-level shipped row to carry real originalLines, but ${stillPlaceholder.length} still only have the placeholder item with nothing to recover it from`);
assert(shipped3.every((r) => r.originalLines && r.originalLines.length > 0), "every order-level-mode row must carry its original per-SKU rerun lines");
const anyPlaceholderInOriginalLines = shipped3.some((r) => r.originalLines.some((ol) => ol.item === "(All SKUs — order-level match)"));
assert(!anyPlaceholderInOriginalLines, "originalLines must contain real D365 item numbers, never the placeholder");

// Spot check one specific order end to end.
const sample = shipped3.find((r) => r.originalLines.length >= 1);
console.log("Sample order:", JSON.stringify({ salesOrder: sample.salesOrder, item: sample.item, originalLines: sample.originalLines }));
assert(/^IM8-/.test(sample.originalLines[0].item), `expected a real IM8- item number in originalLines, got '${sample.originalLines[0].item}'`);

// ---- The full app.js expansion logic (mirrored here) must produce one line per original SKU ----
function isServiceSku(sku) { return String(sku || "").toUpperCase().startsWith("IM8-SER-"); }
const shippedLines = [];
for (const r of shipped3) {
  const salesOrderId = r.salesOrder || r.key;
  if (r.originalLines && r.originalLines.length) {
    for (const line of r.originalLines) {
      shippedLines.push({ item: line.item, salesOrder: salesOrderId, qty: line.qty, isService: isServiceSku(line.item) });
    }
  }
}
assert(shippedLines.every((l) => /^H007-SO-\d+$/.test(l.salesOrder)), "expanded shipped lines must all carry the real D365 SO format");
assert(shippedLines.every((l) => /^IM8-/.test(l.item)), "expanded shipped lines must all carry real item numbers, no placeholders");
const totalQtyFromExpansion = shippedLines.reduce((s, l) => s + l.qty, 0);
console.log("Total qty from expanded original lines (WH03 only):", totalQtyFromExpansion, "(expected 272, matching the known-good example)");
assert(totalQtyFromExpansion === 272, `expected WH03's expanded-lines total to be 272, got ${totalQtyFromExpansion}`);

if (!ok) {
  console.error("\nTASK B ORDER ID / SKU TEST FAILED");
  process.exit(1);
}
console.log("TASK B ORDER ID / SKU TEST PASSED");
