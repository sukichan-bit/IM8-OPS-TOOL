// Shared helpers for reading uploaded Excel/CSV exports into row-object arrays.
// Port of lib/io_utils.py — same three-tier fuzzy column matching, header-row
// guessing, sheet picking, and wide "SKU 1/SKU 2/..." block unpivoting.
//
// Reading uses SheetJS (window.XLSX) — far more tolerant of real-world file
// quirks than ExcelJS in testing. Writing (toExcelBytes) uses ExcelJS instead,
// since SheetJS's free/community build silently drops cell fill styles on
// write (confirmed: highlighting requires ExcelJS).

function normalize(s) {
  return String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " ");
}

function isExcelFilename(filename) {
  return /\.(xlsx|xls|xlsm)$/i.test(String(filename));
}

function toNum(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function parseCsv(text) {
  // Minimal RFC4180-ish CSV parser: handles quoted fields with embedded commas/newlines.
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

function getXlsxLib() {
  return typeof XLSX !== "undefined" ? XLSX : require("xlsx");
}

// fileBytes: ArrayBuffer (browser) or Buffer (node). Returns a SheetJS workbook,
// or null for non-Excel filenames (caller should use parseCsv instead).
function loadWorkbook(fileBytes, filename) {
  if (!isExcelFilename(filename)) return null;
  const XLSXLib = getXlsxLib();
  const data = fileBytes instanceof ArrayBuffer ? new Uint8Array(fileBytes) : fileBytes;
  return XLSXLib.read(data, { type: "array", cellDates: true });
}

// Re-derives ONE column's date values directly from their raw Excel serial
// numbers, discarding whatever Date objects cellDates:true already produced
// for them. Scoped deliberately narrow (never touches loadWorkbook/every
// date in the tool) — a real WH04 (Chinese WMS "出库单" export) fulfillment
// report was found to have its "OutboundTime" column misconverted by
// SheetJS's own numeric-to-Date logic, off by a consistent ~8 hours
// (verified against that cell's own cached formatted string, e.g. serial
// 46282.230787037035: SheetJS said 2026-09-16T21:31:38Z, the cell's own "w"
// display says "2026-09-17 05:32:20", and the standard 1900-date-system
// formula below matches the cell's own display exactly) — shifting a
// pre-dawn outbound timestamp back to the previous calendar day. This does
// NOT generalize to every date in every file: the exact same "distrust
// SheetJS, trust the raw serial" swap was tried tool-wide once and broke a
// different, already ops-verified-correct date elsewhere (the Refund Date
// tab's "Created date and time"/tier-3 pivot dates), which needs SheetJS's
// original conversion left alone. So this is applied ONLY to the specific
// fulfillment-report shipped-date column at the point it's read (see
// app.js's setupFileUI), never to Open SO workbook dates or anything else.
function excelSerialToDate(serial) {
  return new Date(Math.round((serial - 25569) * 86400 * 1000));
}
function recomputeDateColumnFromRawSerials(fileBytes, filename, sheetName, headerRow, columnName, rows) {
  if (!isExcelFilename(filename)) return rows;
  const XLSXLib = getXlsxLib();
  const data = fileBytes instanceof ArrayBuffer ? new Uint8Array(fileBytes) : fileBytes;
  const wbRaw = XLSXLib.read(data, { type: "array", cellDates: false });
  const wsRaw = wbRaw.Sheets[sheetName];
  if (!wsRaw) return rows;

  // Re-run the exact same raw-rows -> header/dataRows -> blank-row-filter
  // pipeline as sheetToRawRows/loadTableFromRawRows, just against the
  // cellDates:false parse instead. Blank data rows get dropped identically
  // in both parses (a date cell's raw number vs. its Date object are both
  // non-null, so the "is this row blank" test never disagrees between the
  // two), so dataRowsRaw lines up 1:1, in order, with the already-filtered
  // `rows` passed in — safe to index into positionally rather than via
  // sheet cell-address math, which blank rows would otherwise misalign.
  const rawRowsRaw = XLSXLib.utils.sheet_to_json(wsRaw, { header: 1, raw: true, defval: null });
  const headers = (rawRowsRaw[headerRow] || []).map((h) => (h == null ? "" : String(h).trim()));
  const colIdx = headers.indexOf(columnName);
  if (colIdx === -1) return rows;
  const dataRowsRaw = rawRowsRaw.slice(headerRow + 1).filter((r) => r.some((v) => v != null && String(v).trim() !== ""));

  return rows.map((row, i) => {
    const rawVal = dataRowsRaw[i] ? dataRowsRaw[i][colIdx] : undefined;
    if (typeof rawVal !== "number") return row;
    return { ...row, [columnName]: excelSerialToDate(rawVal) };
  });
}

// Same underlying fix as recomputeDateColumnFromRawSerials, applied to a raw
// 2D-array sheet read (sheetToRawRows's own output) instead of a header-keyed
// row-object array — needed for task_c.js's refund-date resolution, which
// reads the Open SO workbook's "Refund Date"/"Action(s)"/"Workings" tabs as
// raw arrays (pivot tables, not a single header row) rather than through
// loadTableFromRawRows. Proven scope of the underlying bug (checked against
// two real Open SO workbooks, 350 real date cells, 100% reproduction): every
// numeric date cell SheetJS's cellDates:true resolves to a Date comes out
// exactly 28,842 seconds (8h 0m 42s) earlier than the same cell's own raw
// serial correctly converted — a fixed, file/format-independent SheetJS
// defect, not a data quirk, so recomputing from the raw serial is always the
// more correct value. No row/column realignment risk here (unlike the
// column-scoped version above): sheet_to_json(header:1) with no range never
// drops rows, so both parses' raw 2D arrays line up cell-for-cell.
function recomputeSheetDatesFromRawSerials(fileBytes, filename, sheetName, rawRows) {
  if (!isExcelFilename(filename)) return rawRows;
  const XLSXLib = getXlsxLib();
  const data = fileBytes instanceof ArrayBuffer ? new Uint8Array(fileBytes) : fileBytes;
  const wbRaw = XLSXLib.read(data, { type: "array", cellDates: false });
  const wsRaw = wbRaw.Sheets[sheetName];
  if (!wsRaw) return rawRows;
  const rawRowsRaw = XLSXLib.utils.sheet_to_json(wsRaw, { header: 1, raw: true, defval: null });
  return rawRows.map((row, r) => {
    const rawRow = rawRowsRaw[r];
    if (!rawRow || !Array.isArray(row)) return row;
    return row.map((cell, c) => {
      if (!(cell instanceof Date) || isNaN(cell.getTime())) return cell;
      const rawVal = rawRow[c];
      return typeof rawVal === "number" ? excelSerialToDate(rawVal) : cell;
    });
  });
}

function listSheets(workbook) {
  return workbook ? workbook.SheetNames : null;
}

// Raw preview: array of arrays (0-indexed rows), no header assumption.
function sheetToRawRows(workbook, sheetName, nRows) {
  const XLSXLib = getXlsxLib();
  const ws = workbook.Sheets[sheetName];
  const rows = XLSXLib.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  return nRows ? rows.slice(0, nRows) : rows;
}

const ALL_CANDIDATE_TERMS_CACHE = new WeakMap();

function flattenCandidateTerms(candidates) {
  const terms = new Set();
  Object.values(candidates).forEach((list) => list.forEach((t) => terms.add(normalize(t))));
  return terms;
}

function rowScore(rowVals, candidateTerms) {
  let score = 0;
  for (const raw of rowVals) {
    if (raw == null) continue;
    const v = String(raw).trim().toLowerCase();
    if (candidateTerms.has(v)) {
      score++;
    } else if (v.includes("/") && candidateTerms.has(normalize(v.split("/")[0]))) {
      score++;
    }
  }
  return score;
}

function guessHeaderRowAndScore(rawRows, candidates, maxScan) {
  maxScan = maxScan || 20;
  const candidateTerms = flattenCandidateTerms(candidates);
  let bestRow = 0;
  let bestScore = -1;
  const limit = Math.min(maxScan, rawRows.length);
  for (let i = 0; i < limit; i++) {
    const score = rowScore(rawRows[i], candidateTerms);
    if (score > bestScore) {
      bestRow = i;
      bestScore = score;
    }
  }
  return { row: bestRow, score: bestScore };
}

// Column-header keyword matching alone can't tell "the live open-order list"
// apart from a same-shaped historical/derived sheet (a "List of Fulfilled
// Orders" or "Workings" scratch tab often scores just as high, or higher,
// than the real "SO Status" sheet purely on header overlap). Nudge by sheet
// name: real exports from this ops team consistently name the canonical
// current-status sheet with "status" in it, and consistently name derived/
// historical/scratch tabs with these other terms.
const SHEET_NAME_BONUS_TERMS = ["status"];
const SHEET_NAME_PENALTY_TERMS = ["fulfilled", "closed", "workings", "linked", "summary", "eu only"];

function sheetNameAdjustment(sheetName) {
  const n = normalize(sheetName);
  let adj = 0;
  if (SHEET_NAME_BONUS_TERMS.some((t) => n.includes(t))) adj += 3;
  if (SHEET_NAME_PENALTY_TERMS.some((t) => n.includes(t))) adj -= 5;
  return adj;
}

// Row count via the sheet's declared used-range (fast — no full materialize).
function sheetRowCount(workbook, sheetName) {
  const ws = workbook.Sheets[sheetName];
  if (!ws || !ws["!ref"]) return sheetToRawRows(workbook, sheetName, null).length;
  const XLSXLib = getXlsxLib();
  const range = XLSXLib.utils.decode_range(ws["!ref"]);
  return range.e.r - range.s.r + 1;
}

// Sheet-name keywords are fragile — the same ops team has renamed the real
// "current open orders" sheet from "SO Status" to plain "SO" between exports,
// which silently drops the name-based bonus below and lets an unrelated
// small scratch tab win on header-keyword overlap alone. Row count is a far
// more robust signal across naming conventions: the real line-item-per-order
// sheet is always dramatically larger than any scratch/summary/one-off tab,
// regardless of what it's called. log10 keeps this a meaningful tie-breaker
// without letting sheer size override a genuinely better column match.
function pickBestSheet(workbook, candidates, nRows) {
  nRows = nRows || 20;
  let best = { sheet: workbook.SheetNames[0], row: 0, score: -Infinity };
  for (const sheetName of workbook.SheetNames) {
    const preview = sheetToRawRows(workbook, sheetName, nRows);
    const { row, score } = guessHeaderRowAndScore(preview, candidates);
    const sizeBonus = Math.log10(sheetRowCount(workbook, sheetName) + 1);
    const adjustedScore = score + sizeBonus + sheetNameAdjustment(sheetName);
    if (adjustedScore > best.score) best = { sheet: sheetName, row, score: adjustedScore };
  }
  return best;
}

// Load a sheet (or parsed CSV rows) into an array of row-objects using the
// given 0-indexed header row.
function loadTableFromRawRows(rawRows, headerRow) {
  const headers = (rawRows[headerRow] || []).map((h) => (h == null ? "" : String(h).trim()));
  const dataRows = rawRows.slice(headerRow + 1);
  return dataRows
    .filter((r) => r.some((v) => v != null && String(v).trim() !== ""))
    .map((r) => {
      const obj = {};
      headers.forEach((h, i) => {
        if (h) obj[h] = r[i] === undefined ? null : r[i];
      });
      return obj;
    });
}

function loadTableFromSheet(workbook, sheetName, headerRow) {
  const rawRows = sheetToRawRows(workbook, sheetName, null);
  return loadTableFromRawRows(rawRows, headerRow);
}

function fuzzyMatchColumn(columns, candidates) {
  const normLookup = new Map();
  columns.forEach((c) => normLookup.set(normalize(c), c));
  for (const cand of candidates) {
    const nc = normalize(cand);
    if (normLookup.has(nc)) return normLookup.get(nc);
  }

  const segmentLookup = new Map();
  columns.forEach((c) => {
    const s = String(c);
    if (s.includes("/")) {
      const seg = normalize(s.split("/")[0]).replace(/\.+$/, "");
      segmentLookup.set(seg, c);
    }
  });
  for (const cand of candidates) {
    const nc = normalize(cand);
    if (segmentLookup.has(nc)) return segmentLookup.get(nc);
  }

  const noSpace = (s) => normalize(s).replace(/ /g, "");
  const nospaceLookup = new Map();
  columns.forEach((c) => {
    const seg = String(c).split("/")[0];
    nospaceLookup.set(noSpace(seg).replace(/\.+$/, ""), c);
  });
  for (const cand of candidates) {
    const nc = noSpace(cand);
    if (nospaceLookup.has(nc)) return nospaceLookup.get(nc);
  }
  return null;
}

const SKU_BLOCK_RE = /^SKU\s*(\d+)\s*[\r\n]+([\s\S]+)$/i;

function hasSkuBlocks(columns) {
  return columns.some((c) => SKU_BLOCK_RE.test(String(c)));
}

function findField(fieldNames, candidates) {
  for (const f of fieldNames) {
    const seg = normalize(String(f).split("/")[0]);
    if (candidates.has(seg)) return f;
  }
  return null;
}

// Wide "SKU 1\nSKU / SKU 1\nOutbound Qty / ..." per-order-per-row export ->
// one row per (order, SKU line). Non-block fields carry through unchanged.
function unpivotSkuBlocks(rows) {
  if (!rows.length) return rows;
  const columns = Object.keys(rows[0]);
  const blocks = {};
  const baseCols = [];
  for (const col of columns) {
    const m = SKU_BLOCK_RE.exec(col);
    if (!m) {
      baseCols.push(col);
      continue;
    }
    const blockNum = m[1];
    const field = m[2];
    blocks[blockNum] = blocks[blockNum] || {};
    blocks[blockNum][field] = col;
  }

  const out = [];
  for (const blockNum of Object.keys(blocks)) {
    const fields = blocks[blockNum];
    const fieldNames = Object.keys(fields);
    const skuField = findField(fieldNames, new Set(["sku", "item number"]));
    const qtyField = findField(fieldNames, new Set(["outbound qty", "shipped qty", "qty"]));
    if (!skuField || !qtyField) continue;
    const productField = findField(fieldNames, new Set(["product name"]));

    const skuCol = fields[skuField];
    const qtyCol = fields[qtyField];
    const productCol = productField ? fields[productField] : null;

    for (const row of rows) {
      const skuVal = row[skuCol];
      if (skuVal == null || String(skuVal).trim() === "") continue;
      const newRow = {};
      baseCols.forEach((c) => (newRow[c] = row[c]));
      newRow["SKU"] = skuVal;
      newRow["Outbound Qty"] = row[qtyCol];
      if (productCol) newRow["Product Name"] = row[productCol];
      out.push(newRow);
    }
  }
  return out;
}

// Some real exports declare a used-range (and therefore a materialized row
// count via sheet_to_json) orders of magnitude beyond their actual data —
// e.g. a sheet with 237 real rows reporting 1,048,362. Scanning cell
// addresses directly (rather than building the full row-array via
// sheet_to_json, which would materialize ~1M near-empty rows) finds the true
// last populated cell in one column cheaply. colLetter: 1-based Excel column
// letter (e.g. "B"). Returns the 0-indexed row of the last non-blank cell in
// that column, or -1 if the column is entirely empty.
function findLastPopulatedRowInColumn(workbook, sheetName, colLetter) {
  const XLSXLib = getXlsxLib();
  const ws = workbook.Sheets[sheetName];
  if (!ws || !ws["!ref"]) return -1;
  const range = XLSXLib.utils.decode_range(ws["!ref"]);
  for (let r = range.e.r; r >= range.s.r; r--) {
    const cell = ws[`${colLetter}${r + 1}`];
    if (cell != null && cell.v != null && String(cell.v).trim() !== "") return r;
  }
  return -1;
}

// Raw preview bounded to an explicit 0-indexed row range (inclusive) —
// avoids materializing a full sheet_to_json array when the sheet's declared
// range wildly overstates the real data extent (see
// findLastPopulatedRowInColumn above).
function sheetToRawRowsInRange(workbook, sheetName, startRow, endRow) {
  const XLSXLib = getXlsxLib();
  const ws = workbook.Sheets[sheetName];
  const rows = XLSXLib.utils.sheet_to_json(ws, {
    header: 1,
    raw: true,
    defval: null,
    range: { s: { r: startRow, c: 0 }, e: { r: endRow, c: 200 } },
  });
  return rows;
}

// Direct access to a single cell's formula text (no leading "=") and cached
// value, bypassing sheet_to_json (which flattens formula cells down to their
// value alone). colLetter: 1-based Excel column letter, rowNumber: 1-indexed
// Excel row number. Returns null if the cell doesn't exist.
function getCellInfo(workbook, sheetName, colLetter, rowNumber) {
  const ws = workbook.Sheets[sheetName];
  const cell = ws ? ws[`${colLetter}${rowNumber}`] : null;
  if (!cell) return null;
  return { value: cell.v == null ? null : cell.v, formula: cell.f || null };
}

function guessWarehouseFromFilename(filename, knownWarehouses) {
  const upper = String(filename).toUpperCase();
  const matches = knownWarehouses.filter((wh) => upper.includes(String(wh).toUpperCase()));
  return matches.length === 1 ? matches[0] : null;
}

// Named row-highlight styles shared by the on-screen tables (CSS classes of
// the same names) and the exported xlsx (fill + font colors).
const ROW_COLOR_STYLES = {
  red: { fill: "FFFFC7CE", font: "FF9C0006" },
  green: { fill: "FFC6EFCE", font: "FF006100" },
  amber: { fill: "FFFFD966", font: null },
};

// Build an xlsx (as ArrayBuffer/Buffer) from {sheetName: rows[]} + optional
// {sheetName: colorKeyArray} where each entry is 'red'/'green'/'amber'/null,
// aligned to rows. Uses ExcelJS (unlike reading) since it actually supports
// writing cell fill styles.
//
// A sheet entry can also be { columns: [...], rows: [...] } instead of a
// plain array — needed for a deliberately header-only/empty sheet (e.g. a
// D365 import template's unused "serial number" tab), since a plain empty
// array has no row to read column names from. Importers like D365 can
// reject a template whose secondary sheet has literally nothing on it (not
// even headers) even though it's meant to stay empty — verified against a
// real file: an "order"+"serial number" workbook whose serial-number sheet
// had zero rows AND zero headers failed to upload, while the same shape
// with real headers on that empty sheet uploaded fine.
async function toExcelBytes(sheetDict, rowColors) {
  rowColors = rowColors || {};
  const ExcelJSLib = typeof ExcelJS !== "undefined" ? ExcelJS : require("exceljs");
  const wb = new ExcelJSLib.Workbook();
  const usedNames = new Set();

  for (const [sheetName, sheetSpec] of Object.entries(sheetDict)) {
    let safeName = sheetName.replace(/[:\\/?*\[\]]/g, "-").slice(0, 31);
    let suffix = 1;
    while (usedNames.has(safeName)) {
      safeName = safeName.slice(0, 28) + "~" + suffix++;
    }
    usedNames.add(safeName);
    const ws = wb.addWorksheet(safeName);
    const isExplicit = sheetSpec && !Array.isArray(sheetSpec) && Array.isArray(sheetSpec.rows);
    const rows = isExplicit ? sheetSpec.rows : sheetSpec;
    const explicitColumns = isExplicit ? sheetSpec.columns : null;
    if (!rows.length && !explicitColumns) continue;
    // "__"-prefixed keys are internal bookkeeping (join keys, resolution
    // metadata, etc.) — never meant for the exported file an ops user opens.
    const columns = explicitColumns || Object.keys(rows[0]).filter((c) => !c.startsWith("__"));
    ws.addRow(columns).font = { bold: true };
    const colors = rowColors[sheetName];
    rows.forEach((row, idx) => {
      const excelRow = ws.addRow(columns.map((c) => (row[c] === undefined ? null : row[c])));
      const colorKey = colors && colors[idx];
      const style = colorKey && ROW_COLOR_STYLES[colorKey];
      if (style) {
        excelRow.eachCell({ includeEmpty: true }, (cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: style.fill } };
          if (style.font) cell.font = { color: { argb: style.font } };
        });
      }
    });
  }
  return wb.xlsx.writeBuffer();
}

// Browser namespace — app.js calls these as io.xxx(...).
if (typeof window !== "undefined") {
  window.io = {
    normalize,
    isExcelFilename,
    toNum,
    parseCsv,
    loadWorkbook,
    recomputeDateColumnFromRawSerials,
    recomputeSheetDatesFromRawSerials,
    listSheets,
    sheetToRawRows,
    guessHeaderRowAndScore,
    pickBestSheet,
    loadTableFromRawRows,
    loadTableFromSheet,
    fuzzyMatchColumn,
    hasSkuBlocks,
    unpivotSkuBlocks,
    guessWarehouseFromFilename,
    findLastPopulatedRowInColumn,
    sheetToRawRowsInRange,
    getCellInfo,
    toExcelBytes,
  };
}

if (typeof module !== "undefined") {
  module.exports = {
    normalize,
    isExcelFilename,
    toNum,
    parseCsv,
    loadWorkbook,
    recomputeDateColumnFromRawSerials,
    recomputeSheetDatesFromRawSerials,
    listSheets,
    sheetToRawRows,
    guessHeaderRowAndScore,
    pickBestSheet,
    loadTableFromRawRows,
    loadTableFromSheet,
    fuzzyMatchColumn,
    hasSkuBlocks,
    unpivotSkuBlocks,
    guessWarehouseFromFilename,
    findLastPopulatedRowInColumn,
    sheetToRawRowsInRange,
    getCellInfo,
    toExcelBytes,
  };
}
