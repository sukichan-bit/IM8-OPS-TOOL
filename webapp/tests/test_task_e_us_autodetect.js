// Validates Task E's US auto-detection (taskE.autoDetectUsSummaryTable +
// taskE.buildSerLinesFromSignedAmounts) against a REAL TikTok (US)
// Transactions Details export and its real, hand-verified D365 SO Line
// output — the exact pair the user attached when asking for automatic
// column detection. Every field asserted below is cross-checked against
// the real expected-output workbook, not a synthetic guess.
const fs = require("fs");
const io = require("../js/io_utils");
const taskE = require("../js/task_e");

const BASE = "C:/Users/suki.chan_prenetics/Desktop/Claude/im8-open-SO-fulfillment-checking-tools/samples/20260909_tiktok_us";
const sourcePath = `${BASE}/TikTok (US) Transactions Details_Aug 2026.xlsx`;
const expectedPath = `${BASE}/D365_TikTok_US_SO_Lines_Aug2026.xlsx`;

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}

const wb = io.loadWorkbook(fs.readFileSync(sourcePath), sourcePath);
const rawRows = io.sheetToRawRows(wb, "Summary", null);

const auto = taskE.autoDetectUsSummaryTable(rawRows);
assert(auto, "auto-detection should succeed against a real US Summary tab");
assert(auto.itemRecords.length === 17, `expected 17 raw item-table rows (pre bundle-split), got ${auto.itemRecords.length}`);
assert(auto.feeRecords.length === 8, `expected 8 fee columns detected (incl. the one that nets to $0), got ${auto.feeRecords.length}`);
assert(auto.refundLine && auto.refundLine.itemCode === "IM8-SER-000005", "should derive a Refund SER line");
assert(Math.abs(auto.refundLine.amount - -305.56) < 0.01, `expected the Refund line's amount to be -305.56 (item table's own Grand Total, gross, minus the fee pivot's, already refund-netted), got ${auto.refundLine.amount}`);
assert(Math.abs(auto.referenceTotal - 16860.08) < 0.01, `expected the Net earnings reconciliation target to be 16860.08, got ${auto.referenceTotal}`);

// ---- Full pipeline: FG lines (incl. the one real virtual bundle in this file) ----
// No manual bundle composition is supplied here — this file's bundle name
// ("IM8-FG-000127 & IM8-FG-000198 (virtual bundle)") is just its own two
// real SKUs joined by "&", so it must auto-resolve on its own.
const regionInfo = taskE.REGION_DEFAULTS.US;
// Real Item numbers/units seen in this file's own hand-verified output —
// stands in for the shared FG item master (Task F) at test time.
const itemMaster = {
  "IM8-FG-000127": { name: "Tritan Shaker Bottle, 630ml", unit: "pcs" },
  "IM8-FG-000198": { name: "Essentials - Travel Box Set (7ct), Variety - STD", unit: "Box" },
  "IM8-FG-000186": { name: "Daily Ultimate Essentials Pro - Mango + Passion Fruit Trial Pack (7ct)", unit: "Box" },
  "IM8-FG-000254": { name: "Retail - Essentials V2 - Travel Box Set (30ct), Variety -STD", unit: "Box" },
  "IM8-FG-000149": { name: "Daily Ultimate Essentials Pro - Acai + Mixed Berries Trial Pack (7ct)", unit: "Box" },
  "IM8-FG-000185": { name: "Daily Ultimate Essentials Pro - Lemon + Orange Trial Pack (7ct)", unit: "Box" },
};
const { lines: fgLines, unresolvedBundles } = taskE.buildFgLines(auto.itemRecords, regionInfo.warehouse, regionInfo.location, {}, itemMaster);
assert(unresolvedBundles.length === 0, "this file's bundle name is real SKUs joined by & and must auto-resolve with no composition supplied");
assert(fgLines.length === 20, `expected 20 FG lines after bundle-splitting (17 raw rows, 3 of which are the bundle and split into 2 each), got ${fgLines.length}`);
assert(fgLines.every((l) => l["Product name"] && l.Unit), "every FG line should have its Product name and Unit backfilled from the item master");
assert(fgLines.find((l) => l["Item number"] === "IM8-FG-000127").Unit === "pcs", "IM8-FG-000127's real Unit is 'pcs', not the generic default other SKUs share");
assert(fgLines.find((l) => l["Item number"] === "IM8-FG-000198").Unit === "Box", "IM8-FG-000198's real Unit is 'Box'");

const feeRecordsAll = auto.feeRecords.concat(auto.refundLine ? [auto.refundLine] : []);
const { lines: feeLines, zeroSkipped } = taskE.buildSerLinesFromSignedAmounts(feeRecordsAll);
assert(zeroSkipped.length === 1, `expected exactly 1 fee column to net to $0 (skipped), got ${JSON.stringify(zeroSkipped)}`);
assert(feeLines.length === 8, `expected 8 SER lines (7 real fee columns + 1 Refund; the $0 one dropped), got ${feeLines.length}`);

// Quantity sign must follow the amount's own sign, not the fee-type text —
// this file's two "Fulfillment fees" columns are the real regression case
// (one is a fee, -1; the other is that same fee's reimbursement, +1; the
// D365 mapping row spells both identically, so text alone can't tell them apart).
const fulfillmentLines = feeLines.filter((l) => l["Item number"] === "IM8-SER-000023");
assert(fulfillmentLines.length === 2, "expected 2 distinct Fulfillment fees lines (fee + reimbursement)");
assert(fulfillmentLines.some((l) => l.Quantity === -1 && Math.abs(l["Net amount"] - -5184.79) < 0.01), "the fee itself must be a -1 line");
assert(fulfillmentLines.some((l) => l.Quantity === 1 && Math.abs(l["Net amount"] - 9.75) < 0.01), "its reimbursement must be a +1 line, not another -1");

const table = taskE.buildSoLineTable(fgLines, feeLines);
assert(table.length === 28, `expected 28 total SO lines (20 FG + 8 SER), got ${table.length}`);

const rec = taskE.reconcile(table, auto.referenceTotal);
assert(rec.reconciled, `expected the real file to reconcile to the cent against its own Net earnings, got sum=${rec.sum} vs target=${rec.referenceTotal} (diff ${rec.diff})`);

// ---- Cross-check against the real, hand-verified expected-output workbook ----
const expectedWb = io.loadWorkbook(fs.readFileSync(expectedPath), expectedPath);
const expectedRows = io.loadTableFromRawRows(io.sheetToRawRows(expectedWb, "Sheet1", null), 0);
assert(expectedRows.length === table.length, `expected our table to match the real output file's row count (${expectedRows.length}), got ${table.length}`);

const expectedColumns = Object.keys(expectedRows[0]);
assert(expectedColumns.length === 39, `sanity check: expected the real output file to have all 39 D365 SO Line columns, got ${expectedColumns.length}`);
assert(JSON.stringify(Object.keys(table[0])) === JSON.stringify(expectedColumns), `our table's column set/order must match the real output file's exactly.\nours: ${JSON.stringify(Object.keys(table[0]))}\ntheirs: ${JSON.stringify(expectedColumns)}`);

const check127 = table.find((r) => r["Item number"] === "IM8-FG-000127" && r.Quantity === 8);
const expected127 = expectedRows.find((r) => r["Item number"] === "IM8-FG-000127" && r.Quantity === 8);
for (const col of expectedColumns) {
  if (col === "Created date and time") continue; // timestamp-ish/blank in both — not worth a brittle exact-equality check
  assert(
    JSON.stringify(check127[col]) === JSON.stringify(expected127[col]),
    `column "${col}" for IM8-FG-000127 (qty 8) should match the real output exactly: ours=${JSON.stringify(check127[col])} theirs=${JSON.stringify(expected127[col])}`
  );
}

const expectedNetSum = expectedRows.reduce((s, r) => s + (typeof r["Net amount"] === "number" ? r["Net amount"] : 0), 0);
const ourNetSum = table.reduce((s, r) => s + (typeof r["Net amount"] === "number" ? r["Net amount"] : 0), 0);
assert(Math.abs(expectedNetSum - ourNetSum) < 0.01, `expected our table's Net amount sum (${ourNetSum.toFixed(2)}) to match the real output file's (${expectedNetSum.toFixed(2)})`);

// Spot-check a handful of exact rows against the real expected output.
function findExpected(item, qty) {
  return expectedRows.find((r) => r["Item number"] === item && r["Quantity"] === qty);
}
const check1 = findExpected("IM8-FG-000127", 8);
assert(check1 && check1["Unit price"] === 15 && check1["Net amount"] === 120, "IM8-FG-000127 qty 8 should be unitPrice 15 / net 120 in the real output");
const checkRefund = findExpected("IM8-SER-000005", -1);
assert(checkRefund && Math.abs(checkRefund["Net amount"] - -305.56) < 0.01, "the real output's Refund line should be qty -1, net -305.56");

if (!ok) {
  console.error("\nTASK E US AUTO-DETECT TEST FAILED");
  process.exit(1);
}
console.log("TASK E US AUTO-DETECT TEST PASSED");
