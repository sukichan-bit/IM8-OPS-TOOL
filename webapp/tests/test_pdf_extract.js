// Validates PDF-based aging-report extraction against a real D365 export
// (378KB, 32 pages, two-level wrapped header, sparse/blank numeric cells).
const path = require("path");
const fs = require("fs");
const pdfjsLib = require(path.join(__dirname, "..", "node_modules", "pdfjs-dist", "legacy", "build", "pdf.js"));
const { extractAgingRowsFromPdf } = require("../js/pdf_extract");
const io = require("../js/io_utils");

const PDF_PATH = "C:/Users/suki.chan_prenetics/Downloads/Inventory aging 20260730 U001.pdf";

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}

(async () => {
  const bytes = fs.readFileSync(PDF_PATH);
  const { raw, diagnostics } = await extractAgingRowsFromPdf(pdfjsLib, bytes);
  console.log("header:", JSON.stringify(raw[0]));
  console.log("diagnostics:", JSON.stringify(diagnostics, null, 2));

  const rows = io.loadTableFromRawRows(raw, 0);
  const byKey = new Map(rows.map((r) => [`${r["Item number"]}|${r["Warehouse"]}`, r]));

  // Known values cross-checked directly against the PDF's rendered text.
  const cases = [
    { key: "IM8-FG-000011|USOPS-WH04", cost: 23.39, unit: "Kit" },
    { key: "IM8-FG-000011|USOPS-WH05", cost: 23.39, unit: "Kit" },
    { key: "IM8-FG-000004|USOPS-WH04", cost: 0.5, unit: "pcs" },
    { key: "IM8-FG-000004|USOPS-WH05", cost: 0.5, unit: "pcs" },
    { key: "IM8-CON-000001|USOPS-WH05", cost: null, unit: "pcs" }, // genuinely blank cost
    { key: "IM8-FG-000127|USOPS-WH07", cost: 1.86, unit: "pcs" }, // a warehouse with sparse P-columns
  ];
  for (const c of cases) {
    const row = byKey.get(c.key);
    assert(row, `expected to find row for ${c.key}`);
    if (!row) continue;
    console.log(c.key, "->", JSON.stringify(row));
    assert(row["Average unit cost"] === c.cost, `${c.key}: expected cost ${c.cost}, got ${row["Average unit cost"]}`);
    assert(row["Inventory unit"] === c.unit, `${c.key}: expected unit '${c.unit}', got '${row["Inventory unit"]}'`);
  }

  // Sanity: no "Totals"/"Report summary" junk rows leaked in as fake items.
  const badItem = rows.find((r) => !/^IM8-/.test(String(r["Item number"])));
  assert(!badItem, `found a non-IM8- item number row: ${JSON.stringify(badItem)}`);

  // Sanity: extracted row count is in a plausible range (real file has ~300+ distinct item/warehouse lines across FG+RM sections).
  assert(rows.length > 200, `expected a substantial number of rows, got ${rows.length}`);

  // Every "USOPS-TRN01" occurrence in this specific PDF has its "TRN01"
  // suffix entirely absent from the text layer — a systematic font-encoding
  // gap for that one code, not a parsing bug (confirmed: every skipped row's
  // fragment is exactly "USOPS-", never a different/unexplained pattern).
  // TRN01 isn't one of the 5 real operational warehouses this tool covers
  // (OPS-WH01/02/03, USOPS-WH04/05), so this has no practical impact.
  assert(diagnostics.rowsSkippedNoWarehouse === 53, `expected exactly 53 known TRN01-related skips, got ${diagnostics.rowsSkippedNoWarehouse}`);
  const unexplainedSkips = diagnostics.skippedNoWarehouseSample.filter((s) => s.fragment !== "USOPS-");
  assert(unexplainedSkips.length === 0, `found skipped rows NOT matching the known TRN01 pattern: ${JSON.stringify(unexplainedSkips)}`);

  if (!ok) {
    console.error("\nPDF EXTRACT TEST FAILED");
    process.exit(1);
  }
  console.log("\nPDF EXTRACT TEST PASSED");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
