// Pins the fix for SheetJS's cellDates:true conversion being off by a fixed
// 28,842 seconds (8h 0m 42s) for certain real date cells — reproduced with
// 100% consistency across two real Open SO workbooks (350+ cells) and a real
// WH04 Chinese-WMS fulfillment export. Two real-world reports triggered this:
// (1) a WH04 order's D365 fulfillment template showing 09/16/2026 instead of
// the WH04 report's real 09/17/2026 outbound date; (2) Step 7's refund-date
// column landing a day early for 88 real orders, confirmed by the user
// against their own hand-verified dates. Both fixes recompute only the
// specific column/tabs affected — not every date in the tool — since a
// tool-wide swap was tried once and broke an earlier, separately-verified
// order (see test_task_c_refund_dates.js's regression case).
const fs = require("fs");
const io = require("../js/io_utils");
const taskC = require("../js/task_c");

const BASE = "C:/Users/suki.chan_prenetics/Desktop/Claude/im8-open-SO-fulfillment-checking-tools";
const DIR = `${BASE}/samples/20260925`;

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}

// ---- Fix 1: fulfillment-report shipped_date column (recomputeDateColumnFromRawSerials) ----
const wh04Path = `${DIR}/20260901-20260925 USOPS-WH04 fulfillment report.xlsx`;
const wh04Buf = fs.readFileSync(wh04Path);
const wh04Wb = io.loadWorkbook(wh04Buf, wh04Path);
const wh04Sheet = "出库单";
const wh04Rows = io.loadTableFromSheet(wh04Wb, wh04Sheet, 0);
const wh04ColName = io.fuzzyMatchColumn(Object.keys(wh04Rows[0]), ["outbound time"]);
assert(wh04ColName, "expected to detect the OutboundTime column in the WH04 sample");

const wh04Fixed = io.recomputeDateColumnFromRawSerials(wh04Buf, wh04Path, wh04Sheet, 0, wh04ColName, wh04Rows);
const wh04Target = wh04Fixed.find((r) => String(r["Reference order No./参考单号"] || "").trim() === "U001-SO-897441");
assert(wh04Target, "expected to find order U001-SO-897441 in the WH04 sample");
assert(
  wh04Target[wh04ColName].toISOString() === "2026-09-17T05:32:20.000Z",
  `expected U001-SO-897441's OutboundTime fixed to 2026-09-17T05:32:20.000Z, got ${wh04Target[wh04ColName].toISOString()}`
);
assert(wh04Fixed.length === wh04Rows.length, "recompute must not add/drop rows");

// ---- Fix 2: Open SO workbook's "Refund Date" tab (recomputeSheetDatesFromRawSerials) ----
const openSoPath = `${DIR}/20260924 U001 Open SO (Sep23).xlsx`;
const openSoBuf = fs.readFileSync(openSoPath);
const openSoWb = io.loadWorkbook(openSoBuf, openSoPath);
const refundDateRawFixed = io.recomputeSheetDatesFromRawSerials(openSoBuf, openSoPath, "Refund Date", io.sheetToRawRows(openSoWb, "Refund Date", null));
const refundDateRows = io.loadTableFromRawRows(refundDateRawFixed, 0);

// Real orders from the user's own hand-verified Step 7 correction (column H
// of their downloaded result) — confirmed correct against the Open SO
// workbook directly, independent of this tool.
const knownCorrect = [
  { so: "U001-SO-910638", expected: "09/22/2026" },
  { so: "U001-SO-908508", expected: "09/22/2026" },
  { so: "U001-SO-904017", expected: "09/20/2026" },
  { so: "U001-SO-893464", expected: "09/15/2026" },
];
for (const { so, expected } of knownCorrect) {
  const row = refundDateRows.find((r) => r["Sales order"] === so);
  assert(row, `expected to find ${so} in the Refund Date tab`);
  const got = taskC.fmtMMDDYYYY(row["Created date and time"]);
  assert(got === expected, `expected ${so}'s Created date and time to be ${expected}, got ${got}`);
}

// End-to-end: buildRefundDateResolver over the corrected rows must resolve
// these same orders (via tier 1) to the same fixed dates.
const cols = { so: "Sales order", date: "Created date and time" };
const resolve = taskC.buildRefundDateResolver(refundDateRows, cols, null, [], { so: null, date: null });
for (const { so, expected } of knownCorrect) {
  const r = resolve(so, null, null);
  assert(r.resolved && r.tier === 1, `expected tier 1 resolution for ${so}`);
  assert(taskC.fmtMMDDYYYY(r.date) === expected, `expected resolved refund date ${expected} for ${so}, got ${taskC.fmtMMDDYYYY(r.date)}`);
}

if (!ok) {
  console.error("\nDATE SERIAL FIX TEST FAILED");
  process.exit(1);
}
console.log("DATE SERIAL FIX TEST PASSED");
