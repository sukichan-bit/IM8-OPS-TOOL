// Tests Task D's disposal-journal path: period-column disambiguation
// (including duplicate headers), batch allocation (single/split/unallocated/
// not-tracked), cost lookup, and the live-formula Cost amount cell.
const taskD = require("../js/task_d");

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}

// ---- Period-column detection (with a deliberately duplicated header) ----
const headerRow = [
  "Item number", "Product name",
  "01/05 - 31/05/2026", "01/06 - 30/06/2026",
  "01/07 - 31/07/2026", "01/07 - 31/07/2026", // duplicate on purpose
];
const periodCols = taskD.findPeriodQuantityColumns(headerRow);
console.log("period columns found:", JSON.stringify(periodCols));
assert(periodCols.length === 4, `expected 4 period columns, got ${periodCols.length}`);
const julyCols = periodCols.filter((c) => c.header === "01/07 - 31/07/2026");
assert(julyCols.length === 2, "expected 2 duplicate July columns");
assert(julyCols[0].colLetter === "E" && julyCols[1].colLetter === "F", `expected colLetters E/F, got ${julyCols.map((c) => c.colLetter)}`);

// ---- Duplicate-column disambiguation: two identically-named columns with
// DIFFERENT data — selecting periodColIndex must read the right one, not
// silently collapse to whichever a name-keyed row object would keep.
const dupRows = [
  headerRow,
  ["ITEM-X", "Widget X", 0, 0, 999, 7], // col E (idx 4) has a decoy value; col F (idx 5) has the real one
];
const dupResult = taskD.computeDisposalJournal({
  rawRows: dupRows, headerRow: 0, itemColIndex: 0, productColIndex: 1,
  periodColIndex: 5, warehouse: "OPS-WH02", adjustmentDate: new Date("2026-07-31T00:00:00.000Z"),
  reasonCode: "DMG", reasonDescription: "Physical damage", onHandIndex: null, costLookup: null, sourceLabel: "test",
});
assert(dupResult.table.length === 1, `expected 1 line from duplicate-column test, got ${dupResult.table.length}`);
assert(dupResult.table[0].Quantity === -7, `expected qty -7 (from col F, not the decoy 999 in col E), got ${dupResult.table[0].Quantity}`);

// ---- Full allocation-branch coverage on a single (non-duplicated) period column ----
// ITEM-A: single batch fully covers (qty 3, batch has 10)
// ITEM-B: needs split across 2 batches (qty 12, batches 7+5)
// ITEM-C: insufficient stock -> UNALLOCATED remainder (qty 20, batch has 6)
// ITEM-D: not present in on-hand snapshot at all -> not-batch-tracked, blank, no flag
// ITEM-E: zero in the period column -> skipped entirely, not a zero-qty line
// ITEM-G: appears in the on-hand file with plenty of available qty, but its
// batch column is always blank — real items like this exist (not tracked by
// batch at all, even though the row itself is real). Must NOT be confused
// with "batch-tracked but currently out of stock" (which should UNALLOCATE).
const singleHeader = ["Item number", "Product name", "01/07 - 31/07/2026"];
const rawRows = [
  singleHeader,
  ["ITEM-A", "Widget A", 3],
  ["ITEM-B", "Widget B", 12],
  ["ITEM-C", "Widget C", 20],
  ["ITEM-D", "Widget D", 4],
  ["ITEM-E", "Widget E", 0],
  ["ITEM-G", "Widget G", 5],
];

const onHandRows = [
  { Item: "ITEM-A", Wh: "OPS-WH02", Avail: 10, Batch: "BATCH-A1" },
  { Item: "ITEM-B", Wh: "OPS-WH02", Avail: 7, Batch: "BATCH-B1" },
  { Item: "ITEM-B", Wh: "OPS-WH02", Avail: 5, Batch: "BATCH-B2" },
  { Item: "ITEM-C", Wh: "OPS-WH02", Avail: 6, Batch: "BATCH-C1" },
  // ITEM-D deliberately absent (not batch-tracked)
  { Item: "ITEM-G", Wh: "OPS-WH02", Avail: 9999, Batch: null }, // real row, huge stock, no batch ever recorded
];
const onHandCols = { item: "Item", warehouse: "Wh", available: "Avail", batch: "Batch" };
const onHandIndex = taskD.buildOnHandIndex(onHandRows, onHandCols);

const agingRows = [
  { Item: "ITEM-A", Wh: "OPS-WH02", Cost: 12.5, Unit: "pcs" },
  { Item: "ITEM-B", Wh: "OPS-WH02", Cost: 4.0, Unit: "pcs" },
  // ITEM-C/D deliberately have no aging-report cost
];
const agingCols = { item: "Item", warehouse: "Wh", cost: "Cost", unit: "Unit" };
const costLookup = taskD.buildAgingCostLookup(agingRows, agingCols);

const result = taskD.computeDisposalJournal({
  rawRows, headerRow: 0, itemColIndex: 0, productColIndex: 1, periodColIndex: 2,
  warehouse: "OPS-WH02", adjustmentDate: new Date("2026-07-31T00:00:00.000Z"),
  reasonCode: "DMG", reasonDescription: "Physical damage",
  onHandIndex, costLookup, sourceLabel: "202607_OPS-WH02_Damaged_Defective_Reports.xlsx",
});

console.log("Diagnostics:", JSON.stringify(result.diagnostics, null, 2));
console.log("Table:", JSON.stringify(result.table, null, 2));
console.log("Row colors:", result.rowColors);

assert(result.columns.length === 22, `expected 22 columns, got ${result.columns.length}`);
assert(result.diagnostics.rawRowCount === 6, `expected 6 raw data rows, got ${result.diagnostics.rawRowCount}`);
assert(result.diagnostics.rowsConsidered === 5, `expected 5 non-zero rows (E excluded), got ${result.diagnostics.rowsConsidered}`);

const itemA = result.table.filter((r) => r["Item number"] === "ITEM-A");
assert(itemA.length === 1, "ITEM-A should produce exactly 1 line (single batch covers)");
assert(itemA[0]["Batch number"] === "BATCH-A1", "ITEM-A should use its only batch");
assert(itemA[0].Quantity === -3, `ITEM-A qty should be -3, got ${itemA[0].Quantity}`);
assert(itemA[0]["Cost amount"].formula === "L2*O2", `expected formula L2*O2, got ${itemA[0]["Cost amount"].formula}`);
assert(itemA[0]["Cost amount"].result === -3 * 12.5, `expected cost amount -37.5, got ${itemA[0]["Cost amount"].result}`);
assert(itemA[0].Disposition === "Disposal" && itemA[0].Disposal === "Yes", "disposal metadata should be set");
assert(itemA[0]["Disposal reason code"] === "DMG" && itemA[0]["Disposal reason description"] === "Physical damage", "reason code/description should carry through");
assert(itemA[0].Date === "07/31/2026", `expected fixed adjustment date, got ${itemA[0].Date}`);

const itemB = result.table.filter((r) => r["Item number"] === "ITEM-B");
assert(itemB.length === 2, `ITEM-B should split across 2 batches, got ${itemB.length} lines`);
assert(itemB.every((r) => r.Quantity < 0), "all ITEM-B split lines should be negative");
const bTotal = itemB.reduce((s, r) => s + r.Quantity, 0);
assert(bTotal === -12, `ITEM-B split lines should sum to -12, got ${bTotal}`);
// largest-first: batch B1 (qty 7) taken before B2 (qty 5)
assert(itemB[0]["Batch number"] === "BATCH-B1" && itemB[0].Quantity === -7, "largest batch (B1, qty 7) should be used first");
assert(itemB[1]["Batch number"] === "BATCH-B2" && itemB[1].Quantity === -5, "remainder should come from B2");
const bColorIdx = result.table.indexOf(itemB[0]);
assert(result.rowColors[bColorIdx] === "amber", "split lines should be flagged amber");

const itemC = result.table.filter((r) => r["Item number"] === "ITEM-C");
assert(itemC.length === 2, `ITEM-C should produce 2 lines (1 real batch + 1 unallocated), got ${itemC.length}`);
const cUnallocated = itemC.find((r) => r["Batch number"] === "");
assert(cUnallocated, "ITEM-C should have an unallocated (blank batch) line");
assert(cUnallocated.Quantity === -14, `expected unallocated shortfall of -14 (20-6), got ${cUnallocated.Quantity}`);
assert(cUnallocated.Flag.includes("UNALLOCATED"), "unallocated line should be flagged");
const cColorIdx = result.table.indexOf(cUnallocated);
assert(result.rowColors[cColorIdx] === "red", "unallocated line should be flagged red");
assert(result.diagnostics.unallocatedLines.length === 1 && result.diagnostics.unallocatedLines[0].item === "ITEM-C", "diagnostics should list the unallocated line");

const itemD = result.table.filter((r) => r["Item number"] === "ITEM-D");
assert(itemD.length === 1, "ITEM-D (not batch-tracked) should still produce exactly 1 line");
assert(itemD[0]["Batch number"] === "", "ITEM-D should have a blank batch number");
assert(itemD[0].Flag === "", "ITEM-D should NOT be flagged (not-tracked is expected, not an error)");
assert(result.rowColors[result.table.indexOf(itemD[0])] === null, "ITEM-D line should not be highlighted");

const itemE = result.table.filter((r) => r["Item number"] === "ITEM-E");
assert(itemE.length === 0, "ITEM-E (zero damage qty) should produce no lines at all");

const itemG = result.table.filter((r) => r["Item number"] === "ITEM-G");
assert(itemG.length === 1, "ITEM-G (real row, huge stock, but blank batch) should produce exactly 1 line");
assert(itemG[0]["Batch number"] === "", "ITEM-G should have a blank batch number");
assert(itemG[0].Flag === "", "ITEM-G must NOT be flagged UNALLOCATED — it's not batch-tracked, not out of stock");
assert(result.rowColors[result.table.indexOf(itemG[0])] === null, "ITEM-G line should not be highlighted red/amber");
assert(!result.diagnostics.unallocatedLines.some((u) => u.item === "ITEM-G"), "ITEM-G must not appear in unallocatedLines");

assert(result.diagnostics.blankCostLines.length >= 2, "ITEM-C and ITEM-D should be flagged for missing aging-report cost");
assert(result.diagnostics.blankBatchLines.some((b) => b.item === "ITEM-D"), "ITEM-D should be listed among blank-batch lines with a reason");

// ---- Optional SKU aggregation: multiple rows for the same SKU collapse into
// one summed line before batch allocation. Off by default (tested above via
// the omitted aggregateBySku option); this covers the opt-in path.
const aggRawRows = [
  singleHeader,
  ["ITEM-A", "Widget A", 3],
  ["ITEM-A", "Widget A (dup row)", 4], // same SKU, second damage-log entry
  ["ITEM-B", "Widget B", 12],
];
const aggResult = taskD.computeDisposalJournal({
  rawRows: aggRawRows, headerRow: 0, itemColIndex: 0, productColIndex: 1, periodColIndex: 2,
  warehouse: "OPS-WH02", adjustmentDate: new Date("2026-07-31T00:00:00.000Z"),
  reasonCode: "DMG", reasonDescription: "Physical damage",
  onHandIndex, costLookup, sourceLabel: "test", aggregateBySku: true,
});
console.log("Aggregated diagnostics:", JSON.stringify(aggResult.diagnostics, null, 2));
assert(aggResult.diagnostics.rowsConsidered === 3, `expected 3 raw non-zero rows, got ${aggResult.diagnostics.rowsConsidered}`);
assert(aggResult.diagnostics.aggregatedBySku === true, "aggregatedBySku flag should be true");
assert(aggResult.diagnostics.skuGroupsProduced === 2, `expected 2 SKU groups (A, B), got ${aggResult.diagnostics.skuGroupsProduced}`);
const aggItemA = aggResult.table.filter((r) => r["Item number"] === "ITEM-A");
assert(aggItemA.length === 1, `ITEM-A's two rows should collapse into 1 line, got ${aggItemA.length}`);
assert(aggItemA[0].Quantity === -7, `expected combined qty -7 (3+4), got ${aggItemA[0].Quantity}`);
assert(aggItemA[0]["Product name"] === "Widget A", "should keep the first row's product name when aggregating");
assert(aggItemA[0]["Batch number"] === "BATCH-A1", "aggregated ITEM-A line should still get its batch allocated");

// Without aggregateBySku, the same fixture keeps 2 separate ITEM-A lines.
const unaggResult = taskD.computeDisposalJournal({
  rawRows: aggRawRows, headerRow: 0, itemColIndex: 0, productColIndex: 1, periodColIndex: 2,
  warehouse: "OPS-WH02", adjustmentDate: new Date("2026-07-31T00:00:00.000Z"),
  reasonCode: "DMG", reasonDescription: "Physical damage",
  onHandIndex, costLookup, sourceLabel: "test",
});
assert(unaggResult.diagnostics.aggregatedBySku === false, "aggregatedBySku should default to false");
assert(unaggResult.diagnostics.skuGroupsProduced === null, "skuGroupsProduced should be null when aggregation is off");
const unaggItemA = unaggResult.table.filter((r) => r["Item number"] === "ITEM-A");
assert(unaggItemA.length === 2, `without aggregation ITEM-A should stay as 2 separate lines, got ${unaggItemA.length}`);

// ---- Cross-row batch depletion (unaggregated): two separate rows for the
// same SKU must draw down the SAME batch pool sequentially, not each see the
// full untouched quantity (which would double-count real stock).
const tightOnHandRows = [{ Item: "ITEM-H", Wh: "OPS-WH02", Avail: 5, Batch: "BATCH-H1" }];
const tightOnHandIndex = taskD.buildOnHandIndex(tightOnHandRows, onHandCols);
const tightRawRows = [
  singleHeader,
  ["ITEM-H", "Widget H", 3],
  ["ITEM-H", "Widget H", 4], // total need 7, but only 5 available -> shortfall of 2
];
const tightResult = taskD.computeDisposalJournal({
  rawRows: tightRawRows, headerRow: 0, itemColIndex: 0, productColIndex: 1, periodColIndex: 2,
  warehouse: "OPS-WH02", adjustmentDate: new Date("2026-07-31T00:00:00.000Z"),
  reasonCode: "DMG", reasonDescription: "Physical damage",
  onHandIndex: tightOnHandIndex, costLookup: null, sourceLabel: "test",
});
console.log("Cross-row depletion table:", JSON.stringify(tightResult.table.map((r) => ({ batch: r["Batch number"], qty: r.Quantity, flag: r.Flag })), null, 2));
const tightRows = tightResult.table.filter((r) => r["Item number"] === "ITEM-H");
const realBatchQty = tightRows.filter((r) => r["Batch number"] === "BATCH-H1").reduce((s, r) => s + r.Quantity, 0);
const unallocatedQty = tightRows.filter((r) => r["Batch number"] === "").reduce((s, r) => s + r.Quantity, 0);
assert(realBatchQty === -5, `total drawn from BATCH-H1 across both rows must not exceed its 5 available (double-counting bug), got ${realBatchQty}`);
assert(unallocatedQty === -2, `expected a combined shortfall of -2 across both rows (7 needed, 5 available), got ${unallocatedQty}`);

if (!ok) {
  console.error("\nTASK D DISPOSAL TEST FAILED");
  process.exit(1);
}
console.log("\nTASK D DISPOSAL TEST PASSED");
