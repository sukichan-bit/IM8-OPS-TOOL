// Tests Task D's reconciliation-journal path (stocktake vs. system on-hand):
// the column-B-not-max_row extent scan, qty-column header normalization/
// mismatch handling, total-formula range coverage (under vs over), the
// full allocate() branch set (OK/SPLIT/SHORTFALL/NOT_BATCH_TRACKED/
// NOT_IN_D365/NO_OH_AT_WAREHOUSE), non-numeric-amount auto-exclusion, the
// post-build BLOCK reconciliation checks, and the rendered workbook's
// date/formula formatting.
const XLSX = require("xlsx");
const taskD = require("../js/task_d");

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}

// ---- Header normalization: "Qty variant" / "Qty Variant" / "Qty Variant 2" ----
assert(taskD.normalizeQtyHeaderText("Qty variant") === "qty variant", "plain header should normalize");
assert(taskD.normalizeQtyHeaderText("Qty Variant") === "qty variant", "capitalized header should normalize the same");
assert(taskD.normalizeQtyHeaderText("Qty Variant 2") === "qty variant", "numbered header should strip the trailing digit");
assert(taskD.normalizeQtyHeaderText("  Qty   Variant  ") === "qty variant", "whitespace should collapse");

// ---- reconResolveQtyColumn: auto-detect, letter mismatch -> CONFIRM ----
{
  const headerVals = ["", "Item number", "Product name", "Inventory unit", "Warehouse", "On-hand quantity", "", "", "", "Average unit cost", "", "", "", "", "", "", "", "", "", "Qty variant", "Amount variant"];
  const auto = taskD.reconResolveQtyColumn(headerVals, null);
  assert(auto.qtyColIndex === 19, `auto-detect should find col T (idx 19), got ${auto.qtyColIndex}`);
  assert(auto.matched === true && auto.issue === null, "single unambiguous match should not raise an issue");

  const byLetterOk = taskD.reconResolveQtyColumn(headerVals, "T");
  assert(byLetterOk.qtyColIndex === 19 && byLetterOk.matched, "explicit letter T should match and confirm");

  // The spec's real regression: qty column silently moved from L to T between revisions.
  const byLetterStale = taskD.reconResolveQtyColumn(headerVals, "L");
  assert(byLetterStale.matched === false, "column L (which is NOT headed Qty variant here) should not match");
  assert(byLetterStale.issue && byLetterStale.issue.severity === "CONFIRM", `stale column letter should raise CONFIRM, got ${JSON.stringify(byLetterStale.issue)}`);
}

// ---- reconCheckTotalFormulaCoverage: under-coverage BLOCKs, over-coverage NOTEs ----
{
  // H007 WH02 case: total formula stops at row 232, real table runs to 234.
  const extent = { dataStartRow: 3, lastDataRow: 233 }; // Excel rows 4-234
  const under = taskD.reconCheckTotalFormulaCoverage("SUM(M153:M232)", extent);
  assert(under && under.severity === "BLOCK", `under-covering range should BLOCK, got ${JSON.stringify(under)}`);

  // U001 case: SUM(Q3:Q9959) against a few hundred real rows — wider range, harmless.
  const overExtent = { dataStartRow: 3, lastDataRow: 245 }; // Excel rows 4-246
  const over = taskD.reconCheckTotalFormulaCoverage("SUM(Q3:Q9959)", overExtent);
  assert(over && over.severity === "NOTE", `over-covering range should NOTE only, got ${JSON.stringify(over)}`);

  // Exact match -> no issue at all.
  const exact = taskD.reconCheckTotalFormulaCoverage("SUM(T4:T14)", { dataStartRow: 3, lastDataRow: 13 });
  assert(exact === null, `exact-coverage range should raise nothing, got ${JSON.stringify(exact)}`);
}

// ---- Ghost-row extent scan: sheet.max_row trap ----
// Build a worksheet whose declared range runs to row 1,048,362 but which
// only actually has cells for 5 real data rows (Excel rows 4-8) — mirrors
// the U001 WH05 sheet the spec calls out by name. findLastPopulatedRowInColumn
// must return the real last row without materializing ~1M row arrays.
{
  const ws = XLSX.utils.aoa_to_sheet([
    ["", "", ""],
    ["", "", ""],
    ["", "Item number", "Product name"],
    ["", "ITEM-1", "Widget 1"],
    ["", "ITEM-2", "Widget 2"],
    ["", "ITEM-3", "Widget 3"],
    ["", "ITEM-4", "Widget 4"],
    ["", "ITEM-5", "Widget 5"],
  ]);
  ws["!ref"] = "A1:Z1048362"; // the ghost trap
  const wb = { SheetNames: ["S1"], Sheets: { S1: ws } };

  const t0 = Date.now();
  const extent = taskD.reconFindTableExtent(wb, "S1");
  const elapsedMs = Date.now() - t0;
  assert(extent.lastDataRow === 7, `expected last data row idx 7 (Excel row 8), got ${extent.lastDataRow}`);
  assert(extent.rowCount === 5, `expected 5 real data rows, got ${extent.rowCount}`);
  assert(elapsedMs < 5000, `extent scan should be fast even against a 1M-row declared range, took ${elapsedMs}ms`);
}

// ---- Full pipeline: OK / SPLIT (no shortfall) / SPLIT+SHORTFALL / positive
// addition / NOT_IN_D365 / NO_OH_AT_WAREHOUSE / NOT_BATCH_TRACKED / auto-
// excluded non-numeric amount / manual exclusion — all in one run, with
// post-build totals required to reconcile exactly.
{
  const HEADER = ["", "Item number", "Product name", "Inventory unit", "Warehouse", "On-hand quantity", "", "", "", "Average unit cost", "", "", "", "", "", "", "", "", "", "Qty variant", "Amount variant"];
  // Excel rows: 1(blank) 2(financial impact) 3(header) 4..14(data)
  const aoa = [
    [],
    [], // row 2 totals — set directly on cells below (need formula, aoa_to_sheet can't express that)
    HEADER,
    ["", "ITEM-A", "Widget A", "pcs", "OPS-WH02", 100, , , , 10, , , , , , , , , , -5, -50],
    ["", "ITEM-B", "Widget B", "pcs", "OPS-WH02", 100, , , , 10, , , , , , , , , , -12, -120],
    ["", "ITEM-C", "Widget C", "pcs", "OPS-WH02", 100, , , , 15, , , , , , , , , , -20, -300],
    ["", "ITEM-D", "Widget D", "pcs", "OPS-WH02", 100, , , , 10, , , , , , , , , , 8, 80],
    ["", "ITEM-E", "Widget E", "pcs", "OPS-WH02", 100, , , , 10, , , , , , , , , , -4, -40],
    ["", "ITEM-F", "Widget F", "pcs", "OPS-WH02", 100, , , , 10, , , , , , , , , , -3, -30],
    ["", "ITEM-G", "Widget G", "pcs", "OPS-WH02", 100, , , , 10, , , , , , , , , , -5, -50],
    ["", "ITEM-H", "BCareSticker-like", "pcs", "OPS-WH02", 100, , , , 0, , , , , , , , , , 1008, "Non-inventory item"],
    ["", "ITEM-I", "Multi-Vitamin", "pcs", "OPS-WH02", 100, , , , 10, , , , , , , , , , -500, -5000],
    ["", "ITEM-J", "Widget J (zero variance)", "pcs", "OPS-WH02", 100, , , , 10, , , , , , , , , , 0, 0],
    ["", "ITEM-K", "Widget K (blank variance)", "pcs", "OPS-WH02", 100, , , , 10, , , , , , , , , , , ],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["T2"] = { t: "n", v: 467, f: "SUM(T4:T14)" };
  ws["U2"] = { t: "n", v: -5510, f: "SUM(U4:U14)" };
  const wb = { SheetNames: ["OPS-WH02"], Sheets: { "OPS-WH02": ws } };

  const onHandRows = [
    { Item: "ITEM-A", Wh: "OPS-WH02", Batch: "BATCH-A1", Avail: 10 },
    { Item: "ITEM-B", Wh: "OPS-WH02", Batch: "BATCH-B1", Avail: 7 },
    { Item: "ITEM-B", Wh: "OPS-WH02", Batch: "BATCH-B2", Avail: 5 },
    { Item: "ITEM-C", Wh: "OPS-WH02", Batch: "BATCH-C1", Avail: 6 },
    { Item: "ITEM-D", Wh: "OPS-WH02", Batch: "BATCH-D1", Avail: 3 },
    { Item: "ITEM-D", Wh: "OPS-WH02", Batch: "BATCH-D2", Avail: 9 },
    // ITEM-E deliberately absent everywhere -> NOT_IN_D365
    { Item: "ITEM-F", Wh: "OPS-WH03", Batch: "BATCH-F1", Avail: 20 }, // only at a DIFFERENT warehouse -> NO_OH_AT_WAREHOUSE
    { Item: "ITEM-G", Wh: "OPS-WH02", Batch: null, Avail: 999 }, // real stock, never batch-tracked
  ];
  const onHandCols = { item: "Item", warehouse: "Wh", batch: "Batch", available: "Avail" };
  const onHandIndex = taskD.reconBuildOnHandIndex(onHandRows, onHandCols);

  const result = taskD.reconRunForWarehouse({
    workbook: wb, sheetName: "OPS-WH02", entity: "H007", warehouse: "OPS-WH02",
    qtyColumnOverride: null, journalDate: new Date(Date.UTC(2026, 7, 31)),
    onHandIndex, aliasMap: {}, exclusionTerms: ["Multi-Vitamin"], nonInteractive: false,
  });

  console.log("Recon diagnostics:", JSON.stringify(result.diagnostics, null, 2));
  console.log("Recon issues:", JSON.stringify(result.issues, null, 2));
  console.log("Recon table:", JSON.stringify(result.table.map((r) => ({ item: r["Item number"], batch: r["Batch number"], qty: r.Quantity, flag: r.Flag })), null, 2));

  assert(result.ok === true, `expected a clean run (no BLOCKs), got issues: ${JSON.stringify(result.issues.blocks)}`);
  assert(result.qtyResolution.qtyColIndex === 19, "should auto-resolve to column T");
  assert(result.extent.rowCount === 11, `expected 11 data rows (A-K), got ${result.extent.rowCount}`);
  assert(result.diagnostics.journalQtyTotal === -41, `expected journal qty total -41, got ${result.diagnostics.journalQtyTotal}`);
  assert(result.diagnostics.excludedQtyTotal === 508, `expected excluded qty total 508 (1008 auto + -500 manual = 508), got ${result.diagnostics.excludedQtyTotal}`);
  assert(result.diagnostics.journalAmountTotalSource === -510, `expected journal amount total -510, got ${result.diagnostics.journalAmountTotalSource}`);
  assert(result.diagnostics.excludedAmountTotalSource === -5000, `expected excluded amount total -5000, got ${result.diagnostics.excludedAmountTotalSource}`);
  assert(result.autoExcludeCandidates.length === 1 && result.autoExcludeCandidates[0].item === "ITEM-H", "ITEM-H should be auto-excluded on its non-numeric amount text");
  assert(result.excludedRows.some((r) => r.item === "ITEM-I" && r.exclusionReason === "manual exclusion list"), "ITEM-I (Multi-Vitamin) should be manually excluded by product name");

  const byItem = (item) => result.table.filter((r) => r["Item number"] === item);
  assert(byItem("ITEM-A").length === 1 && byItem("ITEM-A")[0]["Batch number"] === "BATCH-A1", "ITEM-A: single sufficient batch");
  assert(byItem("ITEM-B").length === 2, `ITEM-B should split across 2 batches, got ${byItem("ITEM-B").length}`);
  assert(byItem("ITEM-B").reduce((s, r) => s + r.Quantity, 0) === -12, "ITEM-B split lines should sum to -12");
  assert(byItem("ITEM-C").length === 2, `ITEM-C should produce a split line + a shortfall residual, got ${byItem("ITEM-C").length}`);
  const cShortfall = byItem("ITEM-C").find((r) => r["Batch number"] === "");
  assert(cShortfall && cShortfall.Quantity === -14, `ITEM-C shortfall should be -14 (20 needed, 6 available), got ${cShortfall && cShortfall.Quantity}`);
  assert(cShortfall.Flag.includes("SHORTFALL"), "ITEM-C's residual line should be flagged SHORTFALL");
  assert(byItem("ITEM-D").length === 1 && byItem("ITEM-D")[0]["Batch number"] === "BATCH-D2" && byItem("ITEM-D")[0].Quantity === 8, "ITEM-D positive addition should take the LARGEST batch (D2, avail 9)");
  assert(byItem("ITEM-E").length === 1 && byItem("ITEM-E")[0].Flag.includes("NOT IN D365"), "ITEM-E absent everywhere should be flagged NOT IN D365");
  assert(byItem("ITEM-F").length === 1 && byItem("ITEM-F")[0].Flag.includes("NOT SET UP AT THIS WAREHOUSE"), "ITEM-F present only at another warehouse should be flagged NO_OH_AT_WAREHOUSE");
  assert(byItem("ITEM-G").length === 1 && byItem("ITEM-G")[0]["Batch number"] === "" && byItem("ITEM-G")[0].Flag === "", "ITEM-G (real stock, never batch-tracked) should be blank/unflagged, not an error");
  assert(byItem("ITEM-H").length === 0, "ITEM-H (auto-excluded) should not appear as a journal line");
  assert(byItem("ITEM-I").length === 0, "ITEM-I (manually excluded) should not appear as a journal line");
  assert(byItem("ITEM-J").length === 0 && byItem("ITEM-K").length === 0, "zero/blank-qty rows should never appear");

  assert(result.diagnostics.colorCounts.gray === 1, `expected 1 gray (ITEM-G), got ${result.diagnostics.colorCounts.gray}`);
  assert(result.diagnostics.colorCounts.yellow === 3, `expected 3 yellow split lines (B x2, C x1), got ${result.diagnostics.colorCounts.yellow}`);
  assert(result.diagnostics.colorCounts.red === 2, `expected 2 red (C's shortfall + F), got ${result.diagnostics.colorCounts.red}`);
  assert(result.diagnostics.colorCounts.blue === 1, `expected 1 blue (ITEM-E), got ${result.diagnostics.colorCounts.blue}`);

  // Every Cost price cell blank, every Cost amount cell a live formula.
  assert(result.table.every((r) => r["Cost price"] === null), "Cost price must be blank on every row");
  assert(result.table.every((r) => r["Cost amount"] && typeof r["Cost amount"].formula === "string"), "Cost amount must be a live formula on every row");
  assert(result.table.every((r) => r.Date instanceof Date), "Date must be a real Date object on every row (not a string)");

  // ---- Regression: an under-covering total formula on this same data BLOCKs ----
  const badWs = XLSX.utils.aoa_to_sheet(aoa);
  badWs["T2"] = { t: "n", v: 467, f: "SUM(T4:T14)" };
  badWs["U2"] = { t: "n", v: -5510, f: "SUM(U4:U9)" }; // stops early — misses rows 10-14
  const badWb = { SheetNames: ["OPS-WH02"], Sheets: { "OPS-WH02": badWs } };
  const badResult = taskD.reconRunForWarehouse({
    workbook: badWb, sheetName: "OPS-WH02", entity: "H007", warehouse: "OPS-WH02",
    qtyColumnOverride: null, journalDate: new Date(Date.UTC(2026, 7, 31)),
    onHandIndex, aliasMap: {}, exclusionTerms: ["Multi-Vitamin"], nonInteractive: false,
  });
  assert(badResult.ok === false, "an under-covering total-formula range must BLOCK the run");
  assert(badResult.issues.blocks.some((b) => /under-counts/.test(b.message)), "BLOCK message should explain the under-coverage");

  // ---- Regression: a wrong Financial-impact total (extraction/BLOCK mismatch) ----
  const mismatchWs = XLSX.utils.aoa_to_sheet(aoa);
  mismatchWs["T2"] = { t: "n", v: 467, f: "SUM(T4:T14)" };
  mismatchWs["U2"] = { t: "n", v: -9999, f: "SUM(U4:U14)" }; // wrong cached total, same range
  const mismatchWb = { SheetNames: ["OPS-WH02"], Sheets: { "OPS-WH02": mismatchWs } };
  const mismatchResult = taskD.reconRunForWarehouse({
    workbook: mismatchWb, sheetName: "OPS-WH02", entity: "H007", warehouse: "OPS-WH02",
    qtyColumnOverride: null, journalDate: new Date(Date.UTC(2026, 7, 31)),
    onHandIndex, aliasMap: {}, exclusionTerms: ["Multi-Vitamin"], nonInteractive: false,
  });
  assert(mismatchResult.ok === false, "a Financial-impact total that doesn't match journal+excluded amounts must BLOCK");
  assert(mismatchResult.issues.blocks.some((b) => /does not match the source Financial impact/.test(b.message)), "BLOCK message should name the amount-reconciliation failure");

  // ---- --non-interactive: CONFIRM-worthy conditions become BLOCK ----
  const strictResult = taskD.reconRunForWarehouse({
    workbook: wb, sheetName: "OPS-WH02", entity: "H007", warehouse: "OPS-WH02",
    qtyColumnOverride: "L", // deliberately stale/wrong letter -> normally CONFIRM
    journalDate: new Date(Date.UTC(2026, 7, 31)),
    onHandIndex, aliasMap: {}, exclusionTerms: ["Multi-Vitamin"], nonInteractive: true,
  });
  assert(strictResult.ok === false, "non-interactive mode should turn the qty-column CONFIRM into a BLOCK");
  assert(strictResult.issues.confirms.length === 0, "non-interactive mode should leave zero CONFIRMs (all folded into blocks)");
}

// ---- Rendered workbook: real Date + mm/dd/yyyy, blank Cost price, live formula ----
(async () => {
  const table = [
    {
      Date: new Date(Date.UTC(2026, 7, 31)), "Item number": "ITEM-A", "Product name": "Widget A",
      "Manufacturer information": "", Style: "", Site: "Prenetics", Warehouse: "OPS-WH02",
      "Batch number": "BATCH-A1", Location: "Primary", "CW quantity": 0, "CW unit": "",
      Quantity: -5, "Unit quantity": -5, Unit: "pcs", "Cost price": null,
      "Cost amount": { formula: "L2*O2", result: 0 }, Disposition: "", Disposal: "",
      "Disposal reason code": "", "Disposal reason description": "", "Source section": "H007 Reconciliation 2026/08 - OPS-WH02", Flag: "",
    },
    {
      Date: new Date(Date.UTC(2026, 7, 31)), "Item number": "ITEM-G", "Product name": "Widget G",
      "Manufacturer information": "", Style: "", Site: "Prenetics", Warehouse: "OPS-WH02",
      "Batch number": "", Location: "Primary", "CW quantity": 0, "CW unit": "",
      Quantity: -5, "Unit quantity": -5, Unit: "pcs", "Cost price": null,
      "Cost amount": { formula: "L3*O3", result: 0 }, Disposition: "", Disposal: "",
      "Disposal reason code": "", "Disposal reason description": "", "Source section": "H007 Reconciliation 2026/08 - OPS-WH02", Flag: "",
    },
  ];
  const rowColors = [null, "gray"];
  const buf = await taskD.renderReconciliationWorkbook(table, rowColors, "OPS-WH02");

  const wb2 = XLSX.read(buf, { type: "buffer", cellDates: true, cellNF: true, cellStyles: true });
  const ws2 = wb2.Sheets[wb2.SheetNames[0]];
  const dateCell = ws2["A2"];
  assert(dateCell.t === "d" || dateCell.v instanceof Date, `Date cell should be a real date type, got t=${dateCell.t}`);
  assert(dateCell.z === "mm/dd/yyyy", `Date cell number format should be mm/dd/yyyy, got ${dateCell.z}`);
  const costPriceCell = ws2["O2"];
  assert(!costPriceCell || costPriceCell.v == null, `Cost price cell should be blank, got ${JSON.stringify(costPriceCell)}`);
  const costAmountCell = ws2["P2"];
  assert(costAmountCell && costAmountCell.f === "L2*O2", `Cost amount should be a live formula "L2*O2", got ${JSON.stringify(costAmountCell)}`);

  const batchCellGray = ws2["H3"]; // ITEM-G's Batch number cell, row 3
  assert(batchCellGray && batchCellGray.s, "NOT_BATCH_TRACKED row should have a styled (filled) batch cell");
  const otherCellOnGrayRow = ws2["B3"]; // Item number cell on the same gray row — should NOT be filled
  console.log("Batch cell style:", JSON.stringify(batchCellGray && batchCellGray.s));
  console.log("Item-number cell style on gray row:", JSON.stringify(otherCellOnGrayRow && otherCellOnGrayRow.s));

  if (!ok) {
    console.error("\nTASK D RECONCILIATION TEST FAILED");
    process.exit(1);
  }
  console.log("\nTASK D RECONCILIATION TEST PASSED");
})();
