// Tests Steps 5-7: D365 fulfillment templates + inventory adjustment journal.
// Batch lookup uses the REAL on-hand export. Cost/aging-report data is
// synthetic (no real aging report sample exists) but mirrors the spec's
// documented schema exactly.
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

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}

// ---- Batch lookup against REAL on-hand data ----
const onhandRows = readXlsxRows(`${BASE}/samples/20260723 H007 on-hand (as of 1705).xlsx`);
const onhandCols = { item: "Item number", warehouse: "Warehouse", available: "Available physical", batch: "Batch number" };
const batchLookup = taskC.buildBatchLookup(onhandRows, onhandCols);
console.log("batch lookup size:", batchLookup.size);

// Real example from earlier exploration: IM8-FG-000011 at OPS-WH02 had batch
// A249620326 with Available physical=30 (>0) — should resolve.
const realBatch = batchLookup.get("IM8-FG-000011|OPS-WH02");
console.log("real batch for IM8-FG-000011|OPS-WH02:", realBatch);
assert(realBatch === "A249620326", `expected batch A249620326, got ${realBatch}`);

// ---- Steps 5 & 7: fulfillment template rows ----
const cols = { item: "Item number", warehouse: "Warehouse", qty: "Quantity", salesOrder: "Sales order", shopifyRef: "Shopify reference" };

const dispatchedRows = [
  { "Sales order": "SO-100", "Item number": "IM8-FG-000011", Quantity: 2, "Shipped date": "07/20/2026", "Tracking number": "TRACK-1", __warehouse: "OPS-WH02", __multi_tracking: false },
  { "Sales order": "SO-100", "Item number": "IM8-SER-000005", Quantity: 1, "Shipped date": "07/20/2026", "Tracking number": "", __warehouse: "OPS-WH02", __multi_tracking: false },
];
const step5 = taskC.buildFulfillmentTemplateRows(
  dispatchedRows, cols,
  (row) => row["Shipped date"],
  (row, isService) => (isService ? "" : row["Tracking number"]),
  (item, wh) => batchLookup.get(`${item}|${wh}`) || ""
);
console.log("Step 5 rows:", JSON.stringify(step5.rows, null, 2));
assert(step5.rows.length === 3, `expected 3 unit-rows (2+1), got ${step5.rows.length}`); // 2 units of FG + 1 unit of SER
const fgRows5 = step5.rows.filter((r) => r["SKU Number"] === "IM8-FG-000011");
const serRows5 = step5.rows.filter((r) => r["SKU Number"] === "IM8-SER-000005");
assert(fgRows5.length === 2, "expected 2 unit rows for FG line (qty=2)");
assert(fgRows5.every((r) => r["Warehouse location"] === "Prenetics~OPS-WH02~Primary"), "FG warehouse location should be tilde-delimited");
assert(fgRows5.every((r) => r["AWB"] === "TRACK-1"), "FG lines should carry the tracking number");
assert(fgRows5.every((r) => r["Batch Number"] === "A249620326"), "FG batch should come from real on-hand lookup");
assert(serRows5.every((r) => r["Warehouse location"] === "Prenetics~~"), "SER warehouse location should be Prenetics~~");
assert(serRows5.every((r) => r["AWB"] === ""), "SER lines should have blank AWB even in a dispatched order");
assert(serRows5.every((r) => r["Batch Number"] === ""), "SER lines should have no batch number");

const notDispatchedRows = [
  { "Sales order": "SO-200", "Item number": "IM8-FG-000011", Quantity: 1, "Refund Date": "07/10/2026", __warehouse: "OPS-WH02" },
  { "Sales order": "SO-200", "Item number": "IM8-SER-000005", Quantity: 1, "Refund Date": "07/10/2026", __warehouse: "OPS-WH02" },
];
// Step 7 must reuse Step 6's batch assignment, not re-derive — simulate that
// by passing the SAME batchLookup function (in the real pipeline, Step 6 runs
// first and its exact per-item-warehouse batch map is threaded into Step 7).
const step7 = taskC.buildFulfillmentTemplateRows(
  notDispatchedRows, cols,
  (row) => row["Refund Date"],
  (row, isService) => (isService ? "" : "Cancel order"),
  (item, wh) => batchLookup.get(`${item}|${wh}`) || ""
);
console.log("Step 7 rows:", JSON.stringify(step7.rows, null, 2));
const fgRows7 = step7.rows.filter((r) => r["SKU Number"] === "IM8-FG-000011");
const serRows7 = step7.rows.filter((r) => r["SKU Number"] === "IM8-SER-000005");
assert(fgRows7.every((r) => r["AWB"] === "Cancel order"), "FG lines in step 7 should get literal 'Cancel order' AWB");
assert(serRows7.every((r) => r["AWB"] === ""), "SER lines in step 7 should have blank AWB, not 'Cancel order'");
assert(fgRows7[0]["Batch Number"] === fgRows5[0]["Batch Number"], "step7 batch must match step5/6's batch assignment for the same item+warehouse");
assert(serRows7.every((r) => r["Batch Number"] === ""), "SER lines in step 7 should have no batch number");

// ---- Step 6: inventory adjustment journal ----
// Synthetic aging report cost lookup (no real sample exists).
const agingCosts = {
  "IM8-FG-000011|OPS-WH02": { cost: 12.5, unit: "pcs" },
  "IM8-FG-000029|OPS-WH02": { cost: 8.0, unit: "pcs" },
  // IM8-FG-000242 is a $0/missing bundle SKU -> should fall back to composition.
};
const costLookupObj = {
  batchLookup: (item, wh) => batchLookup.get(`${item}|${wh}`) || "",
  costLookup: (item, wh) => agingCosts[`${item}|${wh}`] || null,
  unitLookup: (item) => "pcs",
  manufacturerLookup: (item) => "",
};
const bundleCompositions = {
  "IM8-FG-000242": [{ sku: "IM8-FG-000011", qty: 1 }, { sku: "IM8-FG-000029", qty: 2 }],
};

const todayDate = new Date("2026-07-24T00:00:00.000Z");
const currentMonthRows = [
  { "Sales order": "SO-300", "Item number": "IM8-FG-000011", Quantity: 3, __warehouse: "OPS-WH02", __refund_date_resolution: { date: "2026-07-15T00:00:00.000Z", resolved: true } },
  { "Sales order": "SO-301", "Item number": "IM8-FG-000011", Quantity: 2, __warehouse: "OPS-WH02", __refund_date_resolution: { date: "2026-07-18T00:00:00.000Z", resolved: true } },
  { "Sales order": "SO-302", "Item number": "IM8-FG-000242", Quantity: 1, __warehouse: "OPS-WH02", __refund_date_resolution: { date: "2026-07-20T00:00:00.000Z", resolved: true } },
  { "Sales order": "SO-303", "Item number": "IM8-SER-000005", Quantity: 1, __warehouse: "OPS-WH02", __refund_date_resolution: { date: "2026-07-20T00:00:00.000Z", resolved: true } }, // excluded (SER)
  { "Sales order": "SO-304", "Item number": "IM8-FG-000029", Quantity: 0, __warehouse: "OPS-WH02", __refund_date_resolution: { date: "2026-07-20T00:00:00.000Z", resolved: true } }, // excluded (qty<=0)
  // No aging cost and no bundle composition — must still land in the SAME
  // wh02File table as the resolved-cost rows above, with Cost price/amount
  // left blank (not 0), not split into a separate workbook.
  { "Sales order": "SO-305", "Item number": "IM8-FG-000143", Quantity: 4, __warehouse: "OPS-WH02", __refund_date_resolution: { date: "2026-07-21T00:00:00.000Z", resolved: true } },
];
const pastMonthRows = [
  { "Sales order": "SO-400", "Item number": "IM8-FG-000029", Quantity: 5, __warehouse: "OPS-WH03", __refund_date_resolution: { date: "2026-05-10T00:00:00.000Z", resolved: true } },
];

const journal = taskC.computeInventoryJournal([...currentMonthRows, ...pastMonthRows], cols, costLookupObj, bundleCompositions, todayDate);
console.log("Journal files:", journal.files.map((f) => ({ warehouse: f.warehouse, monthKey: f.monthKey, dateUsed: f.dateUsed, isPastMonthDefaulted: f.isPastMonthDefaulted, rows: f.table.length })));

assert(journal.columns.length === 22, `expected 22 journal columns, got ${journal.columns.length}`);
const wh02File = journal.files.find((f) => f.warehouse === "OPS-WH02" && !f.isPastMonthDefaulted);
assert(wh02File, "expected a current-month OPS-WH02 journal file");
assert(wh02File.table.length === 3, `expected 3 aggregated item rows (000011, 000242, 000143), got ${wh02File.table.length}`); // SER and 0-qty excluded
const row011 = wh02File.table.find((r) => r["Item number"] === "IM8-FG-000011");
assert(row011["Quantity"] === 5, `expected aggregated qty 3+2=5, got ${row011["Quantity"]}`); // 3 (SO-300) + 2 (SO-301)
assert(row011["Cost price"] === 12.5, "cost price should come from aging report");
assert(row011["Cost amount"] === 62.5, `expected cost amount 5*12.5=62.5, got ${row011["Cost amount"]}`);
assert(row011["Date"] === taskC.fmtMMDDYYYY(todayDate), "current-month journal should use today's date");
assert(row011["Site"] === "Prenetics", "Site should always be Prenetics");
assert(row011["Location"] === "Primary", "Location should always be Primary");
assert(row011["CW quantity"] === 0, "CW quantity should always be 0");

const row242 = wh02File.table.find((r) => r["Item number"] === "IM8-FG-000242");
assert(row242["Cost price"] === 12.5 * 1 + 8.0 * 2, `expected bundle cost composition (12.5*1 + 8.0*2 = 28.5), got ${row242["Cost price"]}`);
assert(journal.unresolvedBundles.length === 0, "bundle composition should have resolved cleanly");

const row143 = wh02File.table.find((r) => r["Item number"] === "IM8-FG-000143");
assert(row143, "unresolved-cost item should still appear in the SAME wh02File table, not a separate one");
assert(row143["Cost price"] === "", `expected blank Cost price for unresolved item, got ${JSON.stringify(row143["Cost price"])}`);
assert(row143["Cost amount"] === "", `expected blank Cost amount for unresolved item, got ${JSON.stringify(row143["Cost amount"])}`);
assert(row143["Quantity"] === 4, "unresolved-cost item's quantity should still aggregate normally");
assert(journal.unresolvedCosts.some((u) => u.item === "IM8-FG-000143" && u.warehouse === "OPS-WH02"), "IM8-FG-000143 should be listed in unresolvedCosts");

const wh03File = journal.files.find((f) => f.warehouse === "OPS-WH03");
assert(wh03File.isPastMonthDefaulted === true, "May refund date (past month vs July 'today') should be flagged as defaulted");
assert(wh03File.dateUsed === "05/10/2026", "past-month journal should default to the latest refund date in that group");

if (!ok) {
  console.error("\nTEMPLATE/JOURNAL TEST FAILED");
  process.exit(1);
}
console.log("\nTEMPLATE/JOURNAL TEST PASSED");
