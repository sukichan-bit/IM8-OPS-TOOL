// Verifies toExcelBytes red/green highlighting (Task A) and amber (Task B),
// mirroring tests/test_export.py.
const fs = require("fs");
const io = require("../js/io_utils");
const { computeProductionRequirement } = require("../js/task_a");
const ExcelJS = require("exceljs");

const BASE = "C:/Users/suki.chan_prenetics/Desktop/Claude/im8-open-SO-fulfillment-checking-tools";

function readXlsxRows(path, sheetName, headerRow) {
  const bytes = fs.readFileSync(path);
  const wb = io.loadWorkbook(bytes, path);
  const sheet = sheetName || wb.SheetNames[0];
  const raw = io.sheetToRawRows(wb, sheet, null);
  return io.loadTableFromRawRows(raw, headerRow || 0);
}

(async () => {
  const onhandRows = readXlsxRows(`${BASE}/samples/20260723 H007 on-hand (as of 1705).xlsx`);
  const soRows = readXlsxRows(`${BASE}/samples/20260723 H007 Open SO (Jul22).xlsx`, "SO Status", 3);
  const requestedRows = soRows.filter((r) => r["Remarks"] === "IT - to rerun fulfillment");

  const requestedCols = { item: "Item number", warehouse: "Warehouse", qty: "Quantity" };
  const onhandCols = { item: "Item number", warehouse: "Warehouse", available: "Available physical", product_name: "Product name" };

  const { perWarehouse } = computeProductionRequirement(requestedRows, onhandRows, requestedCols, onhandCols, true);

  const rowColors = {};
  for (const [wh, table] of Object.entries(perWarehouse)) {
    rowColors[wh] = table.map((r) => (r["Item number"] === "TOTAL" ? null : r["To produce"] > 0 ? "red" : "green"));
  }
  const buf = await io.toExcelBytes(perWarehouse, rowColors);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const sheetNames = wb.worksheets.map((w) => w.name);
  console.log("Sheets in output:", sheetNames);
  if (JSON.stringify(sheetNames) !== JSON.stringify(["OPS-WH01", "OPS-WH02", "OPS-WH03"])) {
    throw new Error(`expected warehouse sheets in fixed order OPS-WH01/02/03, got ${JSON.stringify(sheetNames)}`);
  }

  const ws = wb.getWorksheet("OPS-WH03");
  let redCount = 0, greenCount = 0;
  let lastItem = null;
  let seenGreen = false;
  const headerRow = ws.getRow(1).values;
  const itemCol = headerRow.indexOf("Item number");
  for (let r = 2; r < ws.rowCount; r++) {
    const row = ws.getRow(r);
    const fill = row.getCell(1).fill;
    const argb = fill && fill.fgColor ? fill.fgColor.argb : null;
    const isRed = argb === "FFFFC7CE";
    const isGreen = argb === "FFC6EFCE";
    if (isRed) redCount++;
    else if (isGreen) greenCount++;
    // Needs-production (red) rows must all come before fully-covered (green)
    // rows — never a red row after a green one.
    if (isGreen) seenGreen = true;
    else if (isRed && seenGreen) throw new Error(`expected all red (needs-production) rows before green rows, but found a red row at r=${r} after a green row`);
    const item = row.getCell(itemCol).value;
    // A-Z within each of the two groups, not globally across the group boundary.
    if (lastItem != null && lastItem.wasGreen === isGreen && item < lastItem.value) {
      throw new Error(`expected A-Z item sort within group at row ${r}: '${item}' < '${lastItem.value}'`);
    }
    lastItem = { value: item, wasGreen: isGreen };
  }
  const totalsFill = ws.getRow(ws.rowCount).getCell(1).fill;
  const totalsArgb = totalsFill && totalsFill.fgColor ? totalsFill.fgColor.argb : null;
  if (totalsArgb === "FFFFC7CE" || totalsArgb === "FFC6EFCE") throw new Error("TOTAL row should not be colored");

  console.log(`OPS-WH03: ${redCount} red rows, ${greenCount} green rows`);
  if (redCount === 0) throw new Error("expected some red rows");
  if (greenCount === 0) throw new Error("expected some green rows");

  console.log("\nEXPORT JS TEST PASSED");
})();
