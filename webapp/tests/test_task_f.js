// Synthetic-fixture tests for Task F (Amazon -> D365 SO lines), since no real
// Amazon transactions export exists yet in samples/. Mirrors the rules in
// Amazon_Template_Process.md: Summary-tab SER lines derived from Grand Total
// (Duty & Tax skipped, "Sum of other" = Grand Total − Transfer, refund
// counted once), SKU + Refund tab's Order block for FG lines (SKU remap
// applied, subtotal/Grand-Total rows excluded), and mandatory reconciliation
// against the Summary tab's own Net sales figure.
const taskF = require("../js/task_f");

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}

// ---- Build a synthetic Summary tab ----
// row1: "Order" label. row2: "Refund" label, refund amount in col B (idx1).
// row3: "Transfer" label, col M (idx12) used by the "Sum of other" column.
// row4: "Grand Total" label, col C (idx2) + col M (idx12) totals.
// row5: SER item-number row (col C + col M both match IM8-SER-###### so the
// >=2-hit detector finds it). row6: SER name row (fallback names, only used
// for SKUs not already in the seed/override map). row7: "Net sales" cell.
const summaryRows = [];
summaryRows[1] = ["Order"];
summaryRows[2] = ["Refund", -10];
summaryRows[3] = []; summaryRows[3][0] = "Transfer"; summaryRows[3][12] = 5;
summaryRows[4] = []; summaryRows[4][0] = "Grand Total"; summaryRows[4][2] = 100; summaryRows[4][12] = 30;
summaryRows[5] = []; summaryRows[5][2] = "IM8-SER-000003"; summaryRows[5][12] = "IM8-SER-000099";
summaryRows[6] = []; summaryRows[6][2] = "Shipping (unused — seed overrides)"; summaryRows[6][12] = "Sum Of Other Name";
summaryRows[7] = ["Net sales", 150];

const summaryResult = taskF.extractAmazonSummary(summaryRows, taskF.AMAZON_SER_NAME_SEED);
assert(summaryResult.netSales === 150, `expected netSales 150, got ${summaryResult.netSales}`);
assert(summaryResult.serLines.length === 3, `expected 3 SER lines (col C, col M, refund), got ${summaryResult.serLines.length}`);

const colCLine = summaryResult.serLines.find((l) => l.sku === "IM8-SER-000003");
assert(colCLine && colCLine.name === "Shipping Charges", "col C SKU should use the seeded D365 name, not the sheet's own (possibly differently-spelled) label");
assert(colCLine && colCLine.netAmount === 100 && colCLine.qty === 1, "col C line should carry Grand Total's own value as a positive line");

const colMLine = summaryResult.serLines.find((l) => l.sku === "IM8-SER-000099");
assert(colMLine && colMLine.netAmount === 25, `"Sum of other" column should be Grand Total (30) minus Transfer (5) = 25, got ${colMLine && colMLine.netAmount}`);
assert(colMLine && colMLine.name === "Sum Of Other Name", "an unseeded SER SKU should fall back to the sheet's own name row");

const refundLine = summaryResult.serLines.find((l) => l.sku === taskF.AMAZON_REFUND_SKU);
assert(refundLine && refundLine.netAmount === -10 && refundLine.qty === -1, "refund line should carry the Refund row's own (negative) value, counted once");

// Duty & Tax must never appear as its own SER line even if present in either slot.
const dutyRows = [];
dutyRows[1] = ["Order"];
dutyRows[2] = ["Refund", 0];
dutyRows[3] = []; dutyRows[3][0] = "Transfer"; dutyRows[3][12] = 0;
dutyRows[4] = []; dutyRows[4][0] = "Grand Total"; dutyRows[4][2] = 999; dutyRows[4][12] = 0;
dutyRows[5] = []; dutyRows[5][2] = taskF.AMAZON_DUTY_TAX_SKU; dutyRows[5][8] = "IM8-SER-000015";
dutyRows[6] = [];
dutyRows[7] = ["Net sales", 0];
const dutyResult = taskF.extractAmazonSummary(dutyRows, taskF.AMAZON_SER_NAME_SEED);
assert(!dutyResult.serLines.some((l) => l.sku === taskF.AMAZON_DUTY_TAX_SKU), "Duty & Tax SKU must be skipped, never emitted as its own SER line");

// ---- Build a synthetic "SKU + Refund" tab (Order block) ----
const orderRows = [];
orderRows[0] = ["sku", "unit cost", "qty", "sales"]; // header, matched case-insensitively
orderRows[1] = ["IM8-FG-000120", 10, 2, 20];
orderRows[2] = ["IM8-FG-000120 Total"]; // per-SKU subtotal row — must be skipped
orderRows[3] = ["HM-53-0100", 15, 1, 15];
orderRows[4] = ["HM-53-0100 Total"];
orderRows[5] = ["Grand Total"]; // end of Order block — refund detail rows below must never be read

const orderRecords = taskF.extractAmazonOrderLines(orderRows);
assert(orderRecords.length === 2, `expected 2 order records (subtotal/Grand-Total rows excluded), got ${orderRecords.length}`);
assert(orderRecords[0].sku === "IM8-FG-000120" && orderRecords[0].qty === 2 && orderRecords[0].netAmount === 20, "first order record fields");
assert(orderRecords[1].sku === "HM-53-0100" && orderRecords[1].netAmount === 15, "second order record fields (pre-remap SKU)");

// ---- SKU remap + item master ----
assert(taskF.amazonRemapSku("HM-53-0100") === "IM8-FG-000076", "HM-53-0100 should remap to IM8-FG-000076");
assert(taskF.amazonRemapSku("IM8-FG-000120") === "IM8-FG-000120", "an already-real SKU should pass through unchanged");

const itemMaster = { "IM8-FG-000120": { name: "Daily Essentials", unit: "Pouch" } }; // IM8-FG-000076 deliberately NOT mapped
const { lines: fgLines, unmapped } = taskF.buildAmazonFgLines(orderRecords, itemMaster);
assert(fgLines.length === 2, "one FG line per order record");
assert(fgLines[0]["Product name"] === "Daily Essentials" && fgLines[0].Unit === "Pouch", "mapped SKU should carry item-master name/unit");
assert(fgLines[1]["Item number"] === "IM8-FG-000076" && fgLines[1]["Product name"] === "", "remapped-but-unmapped SKU should carry the REMAPPED item number with a blank name, not the original SKU");
assert(unmapped.length === 1 && unmapped[0] === "IM8-FG-000076", `expected exactly IM8-FG-000076 flagged unmapped, got ${JSON.stringify(unmapped)}`);

// ---- Full SO line table + column order + template defaults ----
const serLinesBuilt = taskF.buildAmazonSerLines(summaryResult.serLines);
const table = taskF.buildAmazonSoLineTable(fgLines, serLinesBuilt);
assert(table.length === fgLines.length + serLinesBuilt.length, "table should have one row per FG line + one per SER line");
assert(Object.keys(table[0]).join(",") === taskF.AMAZON_SO_TEMPLATE_COLUMNS.join(","), "every row must carry the exact D365 template column order");
const fgRow = table[0];
assert(fgRow.Warehouse === "USOPS-WH02" && fgRow.Site === "Prenetics" && fgRow["Line status"] === "Open order", "FG rows should carry the documented template defaults");
const serRow = table[table.length - 1];
assert(serRow.Warehouse === null && serRow.Location === null, "SER rows must have Warehouse/Location blanked out (they're not physical stock)");

// ---- Reconciliation ----
// Sum of Net amount across this exact table: FG (20 + 15) + SER (100 + 25 − 10) = 150, matching Net sales.
const rec = taskF.amazonReconcile(table, summaryResult.netSales);
assert(rec.reconciled, `expected the synthetic fixture to reconcile to the cent, got sum=${rec.sum} vs netSales=${rec.netSales} (diff ${rec.diff})`);

const recOff = taskF.amazonReconcile(table, summaryResult.netSales + 5);
assert(!recOff.reconciled && recOff.diff === -5, `expected a deliberately-mismatched netSales to fail reconciliation with diff -5, got ${JSON.stringify(recOff)}`);

// ---- Missing-label / missing-header error handling ----
let threw = false;
try {
  taskF.extractAmazonSummary([["nothing useful here"]], taskF.AMAZON_SER_NAME_SEED);
} catch (e) {
  threw = true;
  assert(/Order, Refund, Transfer, Grand Total/.test(e.message), `error message should name the missing labels, got: ${e.message}`);
}
assert(threw, "extractAmazonSummary must throw (not silently return wrong data) when the Summary tab's layout doesn't match");

threw = false;
try {
  taskF.extractAmazonOrderLines([["not a sku header"]]);
} catch (e) {
  threw = true;
}
assert(threw, 'extractAmazonOrderLines must throw when no "sku" header is found in column A');

if (!ok) {
  console.error("\nTASK F TEST FAILED");
  process.exit(1);
}
console.log("TASK F TEST PASSED");
