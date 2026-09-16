// Task D — D365 Inventory Adjustment / Disposal Journal Generator.
// Port of D365_Journal_Generator_Tool_Spec.md. This file covers the disposal
// journal path (damage/defective report -> negative-only journal lines);
// reconciliation-journal support follows the same shared column/format/batch
// infra but is not yet implemented here.

// ---------- Shared 20(+2)-column D365 journal template ----------

const JOURNAL_D_COLUMNS = [
  "Date", "Item number", "Product name", "Manufacturer information", "Style", "Site",
  "Warehouse", "Batch number", "Location", "CW quantity", "CW unit", "Quantity",
  "Unit quantity", "Unit", "Cost price", "Cost amount", "Disposition", "Disposal",
  "Disposal reason code", "Disposal reason description", "Source section", "Flag",
];

// 1-based column index -> Excel column letter (A, B, ..., Z, AA, ...).
function colLetter(n) {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const QTY_COL_LETTER = colLetter(JOURNAL_D_COLUMNS.indexOf("Quantity") + 1);
const COST_COL_LETTER = colLetter(JOURNAL_D_COLUMNS.indexOf("Cost price") + 1);

function toNumSafe(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return isNaN(n) ? 0 : n;
}

// USOPS-* warehouses belong to the U001 entity; plain OPS-* belong to H007.
// Derived rather than asked for, so it can't silently drift from the
// warehouse actually selected (the spec's "mixing entities" failure mode).
function deriveEntityFromWarehouse(warehouse) {
  return /^USOPS/i.test(String(warehouse || "").trim()) ? "U001" : "H007";
}

// ---------- Damage/defective report: period-quantity column detection ----------

// Matches header text like "01/07 - 31/07/2026". Real reports can have this
// exact header repeated more than once (seen in practice) — callers must
// disambiguate by column letter, never assume the first/only match.
const PERIOD_HEADER_REGEX = /\d{1,2}\/\d{1,2}\s*-\s*\d{1,2}\/\d{1,2}\/\d{4}/;

function findPeriodQuantityColumns(headerRowValues) {
  return headerRowValues
    .map((header, idx) => ({ header: header == null ? "" : String(header).trim(), colIndex: idx, colLetter: colLetter(idx + 1) }))
    .filter((c) => PERIOD_HEADER_REGEX.test(c.header));
}

// ---------- On-hand batch index (entity/warehouse-scoped) ----------

// presence: every Item+Warehouse pair with at least one row carrying a real
// (non-blank) batch number — i.e. genuinely batch-tracked in D365. Some items
// appear in the on-hand export with real available qty but a permanently
// blank batch column (not batch-tracked at all); those must NOT count as
// presence, or a perfectly healthy item gets misread as "out of stock" and
// flagged UNALLOCATED instead of "not batch-tracked" (blank, no flag).
// batches: Item+Warehouse -> [{batch, qty}] for qty>0 rows only.
function buildOnHandIndex(onHandRows, cols) {
  const presence = new Set();
  const batches = new Map();
  for (const row of onHandRows) {
    const item = row[cols.item];
    const wh = row[cols.warehouse];
    if (item == null || wh == null) continue;
    const batch = row[cols.batch];
    if (batch == null || String(batch).trim() === "") continue;
    const key = `${item}|${wh}`;
    presence.add(key);
    const avail = toNumSafe(row[cols.available]);
    if (avail > 0) {
      if (!batches.has(key)) batches.set(key, []);
      batches.get(key).push({ batch: String(batch).trim(), qty: avail });
    }
  }
  return { presence, batches };
}

// ---------- Aging-report cost lookup ----------

function buildAgingCostLookup(agingRows, cols) {
  const map = new Map();
  for (const row of agingRows) {
    const key = `${row[cols.item]}|${row[cols.warehouse]}`;
    if (map.has(key)) continue;
    const cost = toNumSafe(row[cols.cost]);
    const unit = row[cols.unit];
    map.set(key, { cost, unit: unit != null ? String(unit).trim() : "" });
  }
  return map;
}

// ---------- Batch allocation (negative / disposal adjustments) ----------

// batches: [{batch, qty}] for one Item+Warehouse, qty>0 only. MUTATED in
// place (qty decremented as it's consumed) — callers processing multiple
// lines for the same item+warehouse in one run must pass the SAME array
// across calls (see the batchPools cache in computeDisposalJournal), or two
// separate lines would each allocate from the same untouched batch as if the
// other line's consumption never happened. Caller decides whether "no
// batches" means not-tracked (blank, no flag) vs out-of-stock (this
// function's job) — see computeDisposalJournal.
function allocateDisposalBatches(availableBatches, neededQty) {
  const usable = (availableBatches || []).filter((b) => b.qty > 0);

  const covering = usable.filter((b) => b.qty >= neededQty).sort((a, b) => a.qty - b.qty);
  if (covering.length) {
    covering[0].qty -= neededQty;
    return { lines: [{ batch: covering[0].batch, qty: neededQty }], flag: null };
  }

  const sorted = [...usable].sort((a, b) => b.qty - a.qty);
  let remaining = neededQty;
  const lines = [];
  for (const b of sorted) {
    if (remaining <= 1e-9) break;
    const take = Math.min(b.qty, remaining);
    b.qty -= take;
    lines.push({ batch: b.batch, qty: take });
    remaining -= take;
  }
  if (remaining > 1e-9) {
    lines.push({ batch: null, qty: remaining, unallocated: true });
    return { lines, flag: "unallocated" };
  }
  return { lines, flag: lines.length > 1 ? "split" : null };
}

// ---------- Disposal journal ----------

// rawRows: full sheetToRawRows array (0-indexed, includes header). headerRow:
// 0-indexed row containing headers. itemColIndex/productColIndex/periodColIndex:
// explicit column positions (not names) — required because the source report
// can have duplicate period-column headers that a name-keyed row object would
// silently collide on.
function computeDisposalJournal(opts) {
  const {
    rawRows, headerRow, itemColIndex, productColIndex, periodColIndex,
    warehouse, adjustmentDate, reasonCode, reasonDescription,
    onHandIndex, costLookup, sourceLabel, aggregateBySku,
  } = opts;

  const dataRows = rawRows.slice(headerRow + 1).filter((r) => r && r.some((v) => v != null && String(v).trim() !== ""));
  const dateStr = fmtMMDDYYYY(adjustmentDate);

  // First pass: pull (item, productName, qty) out of each raw row, skipping
  // blanks and rows with no damage recorded for the selected period.
  const entries = [];
  for (const r of dataRows) {
    const item = itemColIndex != null ? r[itemColIndex] : null;
    if (item == null || String(item).trim() === "") continue;
    const productName = productColIndex != null ? r[productColIndex] : null;
    const qtyRaw = toNumSafe(r[periodColIndex]);
    if (qtyRaw === 0) continue;
    entries.push({ item, productName, qty: Math.abs(qtyRaw) });
  }

  // Optional: combine multiple lines for the same SKU into a single adjustment
  // line (summed quantity) before batch allocation. Off by default — some
  // runs genuinely want each source row kept separate for traceability.
  let processedEntries = entries;
  let skuGroupsProduced = null;
  if (aggregateBySku) {
    const byItem = new Map();
    for (const e of entries) {
      if (!byItem.has(e.item)) byItem.set(e.item, { item: e.item, productName: e.productName, qty: 0 });
      const g = byItem.get(e.item);
      g.qty += e.qty;
      if (!g.productName && e.productName) g.productName = e.productName;
    }
    processedEntries = Array.from(byItem.values());
    skuGroupsProduced = processedEntries.length;
  }

  const table = [];
  const rowColors = [];
  const unallocatedLines = [];
  const blankBatchLines = [];
  const blankCostLines = [];

  // Working batch pools, keyed by item+warehouse and cloned once from
  // on-hand data. Shared and depleted across every entry for that key so
  // repeated-SKU rows (when not aggregated) draw down the same real stock
  // instead of each seeing the full untouched quantity.
  const batchPools = new Map();
  function getPool(key) {
    if (!batchPools.has(key)) {
      const src = onHandIndex && onHandIndex.batches.get(key);
      batchPools.set(key, src ? src.map((b) => ({ ...b })) : []);
    }
    return batchPools.get(key);
  }

  for (const { item, productName, qty: neededQty } of processedEntries) {
    const key = `${item}|${warehouse}`;

    let allocation;
    let batchReason = null;
    if (!onHandIndex) {
      allocation = { lines: [{ batch: null, qty: neededQty }], flag: null };
      batchReason = "no on-hand snapshot supplied";
    } else if (!onHandIndex.presence.has(key)) {
      allocation = { lines: [{ batch: null, qty: neededQty }], flag: null };
      batchReason = "item not batch-tracked for this warehouse (expected)";
    } else {
      allocation = allocateDisposalBatches(getPool(key), neededQty);
    }

    const costInfo = costLookup ? costLookup.get(key) : null;
    const hasCost = !!(costInfo && costInfo.cost);
    const costPrice = hasCost ? costInfo.cost : 0;
    const unit = costInfo && costInfo.unit ? costInfo.unit : "";
    if (!hasCost) {
      blankCostLines.push({ item, warehouse, reason: costLookup ? "no aging-report cost for this item/warehouse" : "no aging report supplied" });
    }

    for (const line of allocation.lines) {
      const lineQty = -Math.abs(line.qty);
      const rowNum = table.length + 2; // header occupies sheet row 1
      const flagParts = [];
      if (line.unallocated) {
        flagParts.push("UNALLOCATED — insufficient on-hand stock");
        unallocatedLines.push({ item, warehouse, shortfallQty: line.qty });
      } else if (allocation.flag === "split") {
        flagParts.push("Split across multiple batches — verify");
      }
      if (!line.batch) {
        blankBatchLines.push({ item, warehouse, reason: line.unallocated ? "insufficient stock to allocate a batch" : batchReason });
      }

      table.push({
        Date: dateStr,
        "Item number": item,
        "Product name": productName == null ? "" : String(productName),
        "Manufacturer information": "",
        Style: "",
        Site: "Prenetics",
        Warehouse: warehouse,
        "Batch number": line.batch || "",
        Location: "Primary",
        "CW quantity": 0,
        "CW unit": "",
        Quantity: lineQty,
        "Unit quantity": lineQty,
        Unit: unit,
        "Cost price": costPrice,
        "Cost amount": { formula: `${QTY_COL_LETTER}${rowNum}*${COST_COL_LETTER}${rowNum}`, result: lineQty * costPrice },
        Disposition: "Disposal",
        Disposal: "Yes",
        "Disposal reason code": reasonCode || "",
        "Disposal reason description": reasonDescription || "",
        "Source section": sourceLabel || "",
        Flag: flagParts.join("; "),
      });
      rowColors.push(line.unallocated ? "red" : allocation.flag === "split" ? "amber" : null);
    }
  }

  return {
    table,
    rowColors,
    columns: JOURNAL_D_COLUMNS,
    diagnostics: {
      entity: deriveEntityFromWarehouse(warehouse),
      rawRowCount: dataRows.length,
      rowsConsidered: entries.length,
      aggregatedBySku: !!aggregateBySku,
      skuGroupsProduced,
      rowsProduced: table.length,
      unallocatedLines,
      blankBatchLines,
      blankCostLines,
    },
  };
}

// ---------- D365 fulfillment template for Shipped orders (Task B) ----------
// Generic input, one entry per SO line already known to be "Shipped"
// overall: { item, warehouse, salesOrder, qty, tracking, shippedDate,
// isService, outstandingQty, isMultiTracking }. Reuses the SAME batch
// allocator as the disposal journal (allocateDisposalBatches/
// buildOnHandIndex): batches are consumed SEQUENTIALLY per Item+Warehouse,
// shared across every line in the run — two lines needing the same SKU
// don't each get handed the same untouched batch. Flags "Insufficient
// on-hand batch" per affected unit-row when the pool runs dry, and "Partial
// shipment on this line" when the line's own outstandingQty > 0 (can happen
// even on an order that nets to "Shipped" overall, if a different line on
// the same order over-shipped enough to cover the total).
function buildShippedFulfillmentTemplate(shippedLines, onHandIndex) {
  const table = [];
  const batchPools = new Map();
  function getPool(key) {
    if (!batchPools.has(key)) {
      const src = onHandIndex && onHandIndex.batches.get(key);
      batchPools.set(key, src ? src.map((b) => ({ ...b })) : []);
    }
    return batchPools.get(key);
  }

  const multiTrackingOrders = new Set();
  for (const line of shippedLines) {
    const qty = Math.round(toNumSafe(line.qty));
    if (qty <= 0) continue;
    const warehouseLocation = line.isService ? "Prenetics~~" : `Prenetics~${line.warehouse}~Primary`;
    const shippedDateText = fmtMMDDYYYY(line.shippedDate);
    const awb = line.isService ? "" : line.tracking || "";
    if (line.isMultiTracking) multiTrackingOrders.add(line.salesOrder);

    const baseFlags = [];
    if (line.outstandingQty > 0) baseFlags.push("Partial shipment on this line — verify");

    const pushUnits = (batch, n, extraFlag) => {
      const flags = extraFlag ? [...baseFlags, extraFlag] : baseFlags;
      for (let u = 0; u < n; u++) {
        table.push({
          "Shipped date": shippedDateText,
          "Order ID": line.salesOrder,
          AWB: awb,
          "SKU Number": line.item,
          "Warehouse location": warehouseLocation,
          "Batch Number": batch,
          Flag: flags.join("; "),
        });
      }
    };

    if (line.isService) {
      pushUnits("", qty, null);
      continue;
    }
    const key = `${line.item}|${line.warehouse}`;
    if (!onHandIndex || !onHandIndex.presence.has(key)) {
      pushUnits("", qty, null);
      continue;
    }
    const allocation = allocateDisposalBatches(getPool(key), qty);
    for (const allocLine of allocation.lines) {
      pushUnits(allocLine.batch || "", allocLine.qty, allocLine.unallocated ? "Insufficient on-hand batch" : null);
    }
  }

  return { table, multiTrackingOrders: Array.from(multiTrackingOrders) };
}

// ---------- Reconciliation journal (stocktake vs. system on-hand) ----------
// Turns a month-end inventory reconciliation workbook (one tab per
// warehouse) into a D365 adjustment journal, batch-allocated from an
// on-hand export. Shares the 22-column template, colLetter, and
// deriveEntityFromWarehouse with the disposal-journal path above; batch
// allocation is a separate function (reconAllocateBatches) since this path
// must also handle POSITIVE adjustments and a wider set of no-batch
// reasons (NOT_IN_D365 vs NO_OH_AT_WAREHOUSE vs NOT_BATCH_TRACKED) that the
// disposal path's negative-only allocator doesn't distinguish.

const RECON_HEADER_ROW = 2; // 0-indexed -> Excel row 3
const RECON_DATA_START_ROW = 3; // 0-indexed -> Excel row 4
const RECON_TOTAL_ROW = 1; // 0-indexed -> Excel row 2 (the sheet's own Financial-impact total)

// Fixed source-workbook column positions (section 1.1 — stable across every
// warehouse tab). Qty/amount-variant columns are NOT here — they move
// between files/revisions and must be located per run (see
// reconResolveQtyColumn).
const RECON_COLS = { item: 1, productName: 2, unit: 3, warehouse: 4, onhandQty: 5, avgCost: 9 };

// Standing profile: entity/warehouse defaults for tab name, expected qty-
// column header, and exclusion/alias lists. This is a browser-only tool
// with no backend to persist a YAML file back to disk, so "persisting"
// means: the UI seeds a session-local clone of this (via reconCloneEntities)
// that the operator can add to for the rest of the session; it resets on
// page reload, same as every other piece of state in this app.
const RECON_ENTITIES = {
  H007: {
    "OPS-WH02": { tabName: "OPS-WH02", qtyColumnHeader: "Qty variant", exclusions: ["Multi-Vitamin", "TT-EXPIRY-LABEL"], aliases: {} },
    "OPS-WH03": { tabName: "OPS-WH03", qtyColumnHeader: "Qty Variant", exclusions: ["TEST SKU IM8"], aliases: {} },
  },
  U001: {
    "USOPS-WH04": { tabName: "WH04", qtyColumnHeader: "Qty variant", exclusions: [], aliases: {} },
    "USOPS-WH05": {
      tabName: "WH05",
      qtyColumnHeader: "Qty Variant 2",
      exclusions: [],
      aliases: { "IM8-FAKE-206": "IM8-FG-000206", "IM8-FAKE-215": "IM8-FG-000215", "IM8-FAKE-216": "IM8-FG-000216" },
    },
  },
};

function reconCloneEntities() {
  return JSON.parse(JSON.stringify(RECON_ENTITIES));
}

const RECON_STATUS = {
  OK: "OK",
  SPLIT: "SPLIT",
  SHORTFALL: "SHORTFALL",
  NOT_BATCH_TRACKED: "NOT_BATCH_TRACKED",
  NOT_IN_D365: "NOT_IN_D365",
  NO_OH_AT_WAREHOUSE: "NO_OH_AT_WAREHOUSE",
};

function colLetterToIndex(letters) {
  let n = 0;
  const s = String(letters).trim().toUpperCase();
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n - 1; // 0-indexed
}

// Lowercase, collapse whitespace, drop a trailing digit (so "Qty variant",
// "Qty Variant", and "Qty Variant 2" all normalize the same) — the header
// text is otherwise unpredictable across warehouses/revisions.
function normalizeQtyHeaderText(s) {
  return String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " ").replace(/\s*\d+$/, "").trim();
}
function isQtyVariantHeader(s) {
  return normalizeQtyHeaderText(s) === "qty variant";
}

function reconNormText(v) {
  return v == null ? "" : String(v).trim().toLowerCase();
}

function toNumOrNull(v) {
  if (v == null || String(v).trim() === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return isNaN(n) ? null : n;
}

function reconParseDateOnly(s) {
  if (s instanceof Date) return s;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  return new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
}

function reconYearMonth(date) {
  return `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

const RECON_MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function reconMonYear(date) {
  return `${RECON_MONTH_ABBR[date.getUTCMonth()]}${date.getUTCFullYear()}`;
}

// Filename convention: YYYYMMDD_{ENTITY}_on-hand_report__as_of_HHMM_.xlsx
function reconParseOnHandFilename(filename) {
  const m = /(\d{8})_([A-Za-z0-9]+)_on-hand_report__as_of_(\d{4})_/i.exec(String(filename || ""));
  if (!m) return null;
  const ymd = m[1];
  const hm = m[3];
  return {
    entity: m[2],
    timestamp: new Date(Date.UTC(
      parseInt(ymd.slice(0, 4), 10), parseInt(ymd.slice(4, 6), 10) - 1, parseInt(ymd.slice(6, 8), 10),
      parseInt(hm.slice(0, 2), 10), parseInt(hm.slice(2, 4), 10)
    )),
  };
}

// Never trusts sheet.max_row — some real exports declare a used-range
// (1,048,362 rows in one observed case) orders of magnitude beyond their
// real data (237 rows). Scans column B directly via io.findLastPopulatedRowInColumn.
function reconFindTableExtent(workbook, sheetName) {
  const lastRow = io.findLastPopulatedRowInColumn(workbook, sheetName, "B");
  if (lastRow < RECON_DATA_START_ROW) return { dataStartRow: RECON_DATA_START_ROW, lastDataRow: -1, rowCount: 0 };
  return { dataStartRow: RECON_DATA_START_ROW, lastDataRow: lastRow, rowCount: lastRow - RECON_DATA_START_ROW + 1 };
}

// headerVals: 0-indexed header-row values. qtyColumnSpec: an operator-given
// column letter (string) or 0-indexed number, or null/"" to auto-detect.
// Auto-detect only commits when exactly one column on the header row
// normalizes to "qty variant" — ambiguity is surfaced, never guessed
// (mirrors Task D's own period-column disambiguation above). When the
// operator gives an explicit column, it's still checked against the header
// label — a mismatch raises CONFIRM rather than silently trusting a
// possibly-stale column letter (the spec's WH02 case: qty column moved from
// L to T between two revisions of the same file).
function reconResolveQtyColumn(headerVals, qtyColumnSpec) {
  const candidates = [];
  headerVals.forEach((hv, i) => { if (isQtyVariantHeader(hv)) candidates.push(i); });

  if (qtyColumnSpec != null && qtyColumnSpec !== "") {
    const idx = typeof qtyColumnSpec === "number" ? qtyColumnSpec : colLetterToIndex(qtyColumnSpec);
    const headerText = headerVals[idx] == null ? "" : String(headerVals[idx]).trim();
    const matched = isQtyVariantHeader(headerText);
    return {
      qtyColIndex: idx, amountColIndex: idx + 1, headerText, matched, candidates,
      issue: matched ? null : {
        severity: "CONFIRM",
        message: `Column ${colLetter(idx + 1)} is headed "${headerText || "(blank)"}", not a recognized "Qty variant" label — confirm this is really the quantity column before proceeding.`,
      },
    };
  }

  if (candidates.length === 1) {
    const idx = candidates[0];
    return { qtyColIndex: idx, amountColIndex: idx + 1, headerText: headerVals[idx], matched: true, candidates, issue: null };
  }
  return {
    qtyColIndex: null, amountColIndex: null, headerText: null, matched: false, candidates,
    issue: {
      severity: candidates.length === 0 ? "BLOCK" : "CONFIRM",
      message: candidates.length === 0
        ? "No column on the header row is labeled \"Qty variant\" (or a numbered variant) — specify the quantity column manually."
        : `Multiple columns look like quantity columns (${candidates.map((i) => colLetter(i + 1)).join(", ")}) — specify which one manually.`,
    },
  };
}

// Column E (warehouse) must match the target warehouse on every populated
// data row — otherwise the wrong tab/warehouse was selected.
function reconCheckWarehouseColumn(rawRows, extent, expectedWarehouse) {
  const mismatches = [];
  for (let r = extent.dataStartRow; r <= extent.lastDataRow; r++) {
    const raw = rawRows[r] || [];
    const item = raw[RECON_COLS.item];
    if (item == null || String(item).trim() === "") continue;
    const wh = raw[RECON_COLS.warehouse];
    if (wh == null || String(wh).trim() === "") continue;
    if (String(wh).trim() !== expectedWarehouse) mismatches.push({ row: r + 1, item, warehouse: wh });
  }
  if (!mismatches.length) return null;
  return {
    severity: "BLOCK",
    message: `${mismatches.length} row(s) in column E don't match the target warehouse "${expectedWarehouse}" (e.g. row ${mismatches[0].row}: "${mismatches[0].warehouse}"). Wrong tab or wrong warehouse selected?`,
  };
}

// Parses a same-column SUM formula (e.g. "SUM(M153:M232)") and compares its
// range against the detected data extent. Direction is NOT symmetric:
// under-coverage (the range misses real data) BLOCKs — this is the spec's
// H007 WH02 case, a stale range silently understating the financial impact
// by 8,089. Over-coverage (extra blank rows in range) is harmless, NOTE only.
function reconCheckTotalFormulaCoverage(formulaText, extent) {
  const m = /^SUM\(\s*[A-Za-z]+(\d+)\s*:\s*[A-Za-z]+(\d+)\s*\)$/i.exec(String(formulaText || "").trim());
  if (!m) return { severity: "NOTE", message: `Could not parse the total formula "${formulaText}" to validate its coverage — verify manually.` };
  const startRow = parseInt(m[1], 10);
  const endRow = parseInt(m[2], 10);
  const dataStart1 = extent.dataStartRow + 1;
  const dataEnd1 = extent.lastDataRow + 1;
  if (startRow > dataStart1 || endRow < dataEnd1) {
    return {
      severity: "BLOCK",
      message: `The sheet's own total formula range (rows ${startRow}-${endRow}) does not cover the full detected data range (rows ${dataStart1}-${dataEnd1}) — it under-counts real data. Fix the source total before running.`,
    };
  }
  if (startRow < dataStart1 || endRow > dataEnd1) {
    return {
      severity: "NOTE",
      message: `The sheet's own total formula range (rows ${startRow}-${endRow}) is wider than the detected data range (rows ${dataStart1}-${dataEnd1}) — harmless, but noted.`,
    };
  }
  return null;
}

function reconReadFinancialImpact(workbook, sheetName, colIndex) {
  const letter = colLetter(colIndex + 1);
  const info = io.getCellInfo(workbook, sheetName, letter, RECON_TOTAL_ROW + 1);
  if (!info) return null;
  return { value: typeof info.value === "number" ? info.value : toNumSafe(info.value), formula: info.formula };
}

// Pulls variance rows out of the detected data range. Skips rows with a
// blank/zero/non-numeric qty entirely — never emitted, never counted
// anywhere. A row with a real (nonzero) qty but non-numeric TEXT in the
// amount column (e.g. the literal "Non-inventory item" seen at U001 WH05
// for 3 real-quantity SKUs) is captured separately as an auto-exclude
// candidate — reported for confirmation, never silently dropped and never
// silently kept.
function reconExtractVarianceRows(rawRows, extent, qtyColIndex, amountColIndex) {
  const rows = [];
  const autoExcludeCandidates = [];
  let sourceQtyTotal = 0;
  let sourceAmountTotal = 0;
  let classifiedRowCount = 0;

  for (let r = extent.dataStartRow; r <= extent.lastDataRow; r++) {
    const raw = rawRows[r] || [];
    const item = raw[RECON_COLS.item];
    if (item == null || String(item).trim() === "") { classifiedRowCount++; continue; }
    const qty = toNumOrNull(raw[qtyColIndex]);
    if (qty == null || qty === 0) { classifiedRowCount++; continue; }

    const amountRaw = raw[amountColIndex];
    const amount = toNumOrNull(amountRaw);
    sourceQtyTotal += qty;
    if (amount != null) sourceAmountTotal += amount;

    const entry = {
      rowNumber: r + 1,
      item: String(item).trim(),
      productName: raw[RECON_COLS.productName] == null ? "" : String(raw[RECON_COLS.productName]).trim(),
      unit: raw[RECON_COLS.unit] == null ? "" : String(raw[RECON_COLS.unit]).trim(),
      qty,
      amount: amount == null ? 0 : amount,
    };
    classifiedRowCount++;

    if (amount == null && amountRaw != null && String(amountRaw).trim() !== "") {
      autoExcludeCandidates.push({ ...entry, reason: String(amountRaw).trim() });
      continue;
    }
    rows.push(entry);
  }
  return { rows, autoExcludeCandidates, sourceQtyTotal, sourceAmountTotal, classifiedRowCount };
}

// aliasMap: {sourceSku: d365Sku}. exclusionTerms: strings matched against
// either the row's item number or product name (case-insensitive, exact
// match after trim — the spec's exclusion lists are copy-pasted product
// names/SKUs, not fuzzy patterns). onHandItemSet: every item number present
// anywhere in the on-hand export, used to BLOCK an alias whose target
// doesn't actually exist there and to CONFIRM a kept row whose (post-alias)
// item is absent from the export entirely.
function reconNormalize(rows, autoExcludeCandidates, aliasMap, exclusionTerms, onHandItemSet) {
  const exclusionSet = new Set((exclusionTerms || []).map(reconNormText));
  const exclusionHits = new Set();
  const excludedRows = [];
  const keptRows = [];
  const issues = [];
  const aliasTargetSeen = new Map();

  for (const row of rows) {
    const isExcludedByItem = exclusionSet.has(reconNormText(row.item));
    const isExcludedByName = exclusionSet.has(reconNormText(row.productName));
    if (isExcludedByItem || isExcludedByName) {
      if (isExcludedByItem) exclusionHits.add(reconNormText(row.item));
      if (isExcludedByName) exclusionHits.add(reconNormText(row.productName));
      excludedRows.push({ ...row, sourceItem: row.item, exclusionReason: "manual exclusion list" });
      continue;
    }

    const targetItem = aliasMap[row.item] || row.item;
    if (aliasMap[row.item] && onHandItemSet && !onHandItemSet.has(targetItem)) {
      issues.push({ severity: "BLOCK", message: `Alias "${row.item}" -> "${targetItem}" but "${targetItem}" is not present anywhere in the on-hand export.` });
    }
    if (!aliasTargetSeen.has(targetItem)) aliasTargetSeen.set(targetItem, []);
    aliasTargetSeen.get(targetItem).push(row.item);
    keptRows.push({ ...row, item: targetItem, sourceItem: row.item });
  }

  for (const row of autoExcludeCandidates) {
    excludedRows.push({ ...row, item: aliasMap[row.item] || row.item, sourceItem: row.item, exclusionReason: `auto-detected: "${row.reason}"` });
  }

  for (const [target, sources] of aliasTargetSeen) {
    if (new Set(sources).size > 1) {
      issues.push({ severity: "CONFIRM", message: `Multiple source rows alias to the same D365 SKU "${target}": ${Array.from(new Set(sources)).join(", ")}. Kept as separate lines — combine manually if that's wrong.` });
    }
  }

  for (const term of exclusionSet) {
    if (!exclusionHits.has(term)) {
      issues.push({ severity: "NOTE", message: `Exclusion "${term}" matched no rows in this tab — consider retiring it from the profile.` });
    }
  }

  if (onHandItemSet) {
    for (const row of keptRows) {
      if (!onHandItemSet.has(row.item)) {
        issues.push({ severity: "CONFIRM", message: `"${row.item}" (source "${row.sourceItem}") does not appear anywhere in the on-hand export.` });
      }
    }
  }

  return { keptRows, excludedRows, issues };
}

// byItemWarehouse: (item|warehouse) -> [{batch, available}] for EVERY row
// (including blank-batch ones — needed to tell "not batch-tracked" apart
// from "batch-tracked but out of stock"). itemWarehouses: item -> Set of
// every warehouse it appears at anywhere in the export (NOT_IN_D365 vs
// NO_OH_AT_WAREHOUSE). Arrays are mutated in place by reconAllocateBatches
// as batches are consumed — build one fresh index per run.
function reconBuildOnHandIndex(onHandRows, cols) {
  const byItemWarehouse = new Map();
  const itemWarehouses = new Map();
  const itemSet = new Set();
  const warehousesPresent = new Set();
  const manufacturerByItem = new Map();
  for (const row of onHandRows) {
    const item = row[cols.item];
    const wh = row[cols.warehouse];
    if (item == null || wh == null) continue;
    const itemKey = String(item).trim();
    const whKey = String(wh).trim();
    itemSet.add(itemKey);
    warehousesPresent.add(whKey);
    if (!itemWarehouses.has(itemKey)) itemWarehouses.set(itemKey, new Set());
    itemWarehouses.get(itemKey).add(whKey);
    if (cols.manufacturer && !manufacturerByItem.has(itemKey)) {
      const mfg = row[cols.manufacturer];
      if (mfg != null && String(mfg).trim() !== "") manufacturerByItem.set(itemKey, String(mfg).trim());
    }

    const key = `${itemKey}|${whKey}`;
    if (!byItemWarehouse.has(key)) byItemWarehouse.set(key, []);
    const batch = row[cols.batch];
    byItemWarehouse.get(key).push({
      batch: batch == null || String(batch).trim() === "" ? null : String(batch).trim(),
      available: toNumSafe(row[cols.available]),
    });
  }
  return { byItemWarehouse, itemWarehouses, itemSet, warehousesPresent, manufacturerByItem };
}

// Implements the spec's allocate() pseudocode. Returns [{batch, qty, status}]
// — qty carries the sign of the input (positive stays positive; a negative
// need may split across several negative lines plus a SHORTFALL residual).
function reconAllocateBatches(item, warehouse, qty, onHandIndex, preferRandomForPositive) {
  const key = `${item}|${warehouse}`;
  const records = onHandIndex.byItemWarehouse.get(key);

  if (!records || !records.length) {
    const elsewhere = onHandIndex.itemWarehouses.get(item);
    if (elsewhere && elsewhere.size > 0) return [{ batch: null, qty, status: RECON_STATUS.NO_OH_AT_WAREHOUSE }];
    return [{ batch: null, qty, status: RECON_STATUS.NOT_IN_D365 }];
  }

  const batched = records.filter((r) => r.batch != null);
  if (!batched.length) return [{ batch: null, qty, status: RECON_STATUS.NOT_BATCH_TRACKED }];

  if (qty > 0) {
    const chosen = preferRandomForPositive
      ? batched[Math.floor(Math.random() * batched.length)]
      : batched.reduce((a, b) => (b.available > a.available ? b : a));
    return [{ batch: chosen.batch, qty, status: RECON_STATUS.OK }];
  }

  const need = Math.abs(qty);
  const sufficient = batched.filter((b) => b.available >= need);
  if (sufficient.length) {
    const smallest = sufficient.reduce((a, b) => (b.available < a.available ? b : a));
    smallest.available -= need;
    return [{ batch: smallest.batch, qty, status: RECON_STATUS.OK }];
  }

  const sorted = [...batched].sort((a, b) => b.available - a.available);
  const lines = [];
  let remaining = need;
  for (const b of sorted) {
    if (remaining <= 1e-9 || b.available <= 0) break;
    const take = Math.min(b.available, remaining);
    b.available -= take;
    lines.push({ batch: b.batch, qty: -take, status: RECON_STATUS.SPLIT });
    remaining -= take;
  }
  if (remaining > 1e-9) {
    lines.push({ batch: null, qty: -remaining, status: RECON_STATUS.SHORTFALL, availableCovered: need - remaining });
  }
  return lines;
}

function reconFlagForStatus(status, line) {
  switch (status) {
    case RECON_STATUS.SHORTFALL: return `SHORTFALL — ${Math.abs(line.qty)} unit(s) could not be allocated to any batch`;
    case RECON_STATUS.NO_OH_AT_WAREHOUSE: return "NOT SET UP AT THIS WAREHOUSE — item exists in D365 but not here; set up in D365, zero here";
    case RECON_STATUS.NOT_IN_D365: return "NOT IN D365 — item not found anywhere in the on-hand export";
    case RECON_STATUS.SPLIT: return "Split across multiple batches — verify";
    default: return "";
  }
}
// NOT_BATCH_TRACKED fills only the Batch-number cell gray (per spec); every
// other condition fills the whole row.
function reconColorForStatus(status) {
  switch (status) {
    case RECON_STATUS.NOT_BATCH_TRACKED: return "gray";
    case RECON_STATUS.SPLIT: return "yellow";
    case RECON_STATUS.SHORTFALL: return "red";
    case RECON_STATUS.NO_OH_AT_WAREHOUSE: return "red";
    case RECON_STATUS.NOT_IN_D365: return "blue";
    default: return null;
  }
}

// Pure pipeline core: extract -> normalize -> allocate -> validate -> table.
// extraIssues: pre-flight findings from the caller (warehouse-column check,
// qty-column resolution, total-formula-range check) folded through the same
// BLOCK/CONFIRM/NOTE gate as everything found here, so the caller doesn't
// have to merge two separate issue lists. nonInteractive: true turns every
// CONFIRM into a BLOCK (for scheduled/unattended runs).
function reconComputeJournal(opts) {
  const {
    entity, warehouse, rawRows, extent, qtyColIndex, amountColIndex,
    journalDate, onHandIndex, priorOnHandIndex, aliasMap, exclusionTerms,
    qtyFinancialImpact, amountFinancialImpact, nonInteractive, extraIssues, snapshotTimestamp,
  } = opts;

  const blocks = [];
  const confirms = [];
  const notes = [];
  function pushIssue(issue) {
    if (!issue) return;
    if (issue.severity === "BLOCK" || (nonInteractive && issue.severity === "CONFIRM")) blocks.push(issue);
    else if (issue.severity === "CONFIRM") confirms.push(issue);
    else notes.push(issue);
  }
  (extraIssues || []).forEach(pushIssue);

  const empty = {
    table: [], rowColors: [], columns: JOURNAL_D_COLUMNS, issues: { blocks, confirms, notes },
    diagnostics: {}, reviewQueue: { red: [], yellow: [], gray: [], blue: [] }, excludedRows: [], autoExcludeCandidates: [],
  };
  if (qtyColIndex == null || !rawRows.length) return { ...empty, ok: blocks.length === 0 };

  if (amountFinancialImpact && amountFinancialImpact.formula) {
    pushIssue(reconCheckTotalFormulaCoverage(amountFinancialImpact.formula, extent));
  }

  const extracted = reconExtractVarianceRows(rawRows, extent, qtyColIndex, amountColIndex);
  const normalized = reconNormalize(extracted.rows, extracted.autoExcludeCandidates, aliasMap || {}, exclusionTerms || [], onHandIndex ? onHandIndex.itemSet : null);
  normalized.issues.forEach(pushIssue);

  const table = [];
  const rowColors = [];
  const reviewQueue = { red: [], yellow: [], gray: [], blue: [] };
  const dateObj = journalDate instanceof Date ? journalDate : reconParseDateOnly(journalDate);
  const dateStr = fmtMMDDYYYY(dateObj);
  const sourceSection = `${entity} Reconciliation ${reconYearMonth(dateObj)} - ${warehouse}`;
  let journalQtyTotal = 0;

  for (const row of normalized.keptRows) {
    const lines = onHandIndex ? reconAllocateBatches(row.item, warehouse, row.qty, onHandIndex) : [{ batch: null, qty: row.qty, status: RECON_STATUS.NOT_BATCH_TRACKED }];

    const lineSum = lines.reduce((s, l) => s + l.qty, 0);
    if (Math.abs(lineSum - row.qty) > 1e-6) {
      pushIssue({ severity: "BLOCK", message: `Internal allocation error for "${row.item}": split lines sum to ${lineSum}, expected ${row.qty}.` });
    }

    const manufacturer = (onHandIndex && onHandIndex.manufacturerByItem.get(row.item)) || "";

    lines.forEach((line) => {
      const rowNum = table.length + 2;
      table.push({
        Date: dateObj,
        "Item number": row.item,
        "Product name": row.productName,
        "Manufacturer information": manufacturer,
        Style: "",
        Site: "Prenetics",
        Warehouse: warehouse,
        "Batch number": line.batch || "",
        Location: "Primary",
        "CW quantity": 0,
        "CW unit": "",
        Quantity: line.qty,
        "Unit quantity": line.qty,
        Unit: row.unit,
        "Cost price": null, // stays truly blank — a "" here would turn the Cost amount formula into #VALUE!
        "Cost amount": { formula: `${QTY_COL_LETTER}${rowNum}*${COST_COL_LETTER}${rowNum}`, result: 0 },
        Disposition: "",
        Disposal: "",
        "Disposal reason code": "",
        "Disposal reason description": "",
        "Source section": sourceSection,
        Flag: reconFlagForStatus(line.status, line),
      });
      const color = reconColorForStatus(line.status);
      rowColors.push(color);
      journalQtyTotal += line.qty;
      if (color) {
        const bucket = color === "red" ? "red" : color === "yellow" ? "yellow" : color === "gray" ? "gray" : "blue";
        reviewQueue[bucket].push({
          item: row.item, warehouse, status: line.status, qtyRequired: row.qty, qtyLine: line.qty,
          qtyAvailable: line.availableCovered != null ? line.availableCovered : null,
          shortfall: line.status === RECON_STATUS.SHORTFALL ? Math.abs(line.qty) : null,
        });
      }
    });
  }

  if (extracted.classifiedRowCount !== extent.rowCount) {
    pushIssue({ severity: "BLOCK", message: `${extent.rowCount} data row(s) detected but only ${extracted.classifiedRowCount} were classified — extraction bug, do not proceed.` });
  }
  const excludedQtyTotal = normalized.excludedRows.reduce((s, r) => s + r.qty, 0);
  if (qtyFinancialImpact && typeof qtyFinancialImpact.value === "number") {
    const expected = qtyFinancialImpact.value - excludedQtyTotal;
    if (Math.abs(expected - journalQtyTotal) > 1e-6) {
      pushIssue({ severity: "BLOCK", message: `Journal quantity total (${journalQtyTotal}) should equal the source total (${qtyFinancialImpact.value}) minus excluded quantity (${excludedQtyTotal}) = ${expected}.` });
    }
  }
  const journalAmountTotalSource = normalized.keptRows.reduce((s, r) => s + r.amount, 0);
  const excludedAmountTotalSource = normalized.excludedRows.reduce((s, r) => s + (typeof r.amount === "number" ? r.amount : 0), 0);
  if (amountFinancialImpact && typeof amountFinancialImpact.value === "number") {
    const combined = journalAmountTotalSource + excludedAmountTotalSource;
    if (Math.abs(combined - amountFinancialImpact.value) > 0.01) {
      pushIssue({
        severity: "BLOCK",
        message: `Journal amount total (${journalAmountTotalSource.toFixed(2)}) plus excluded amount total (${excludedAmountTotalSource.toFixed(2)}) = ${combined.toFixed(2)}, which does not match the source Financial impact of ${amountFinancialImpact.value.toFixed(2)}.`,
      });
    }
  }

  if (snapshotTimestamp) {
    const gapDays = Math.abs(dateObj - snapshotTimestamp) / 86400000;
    if (gapDays > 7) {
      pushIssue({ severity: "NOTE", message: `The on-hand snapshot is ${gapDays.toFixed(1)} day(s) from the journal date — batch picks may not reflect month-end reality.` });
    }
  }

  if (priorOnHandIndex && onHandIndex) {
    for (const row of normalized.keptRows) {
      const key = `${row.item}|${warehouse}`;
      const priorBatches = priorOnHandIndex.byItemWarehouse.get(key) || [];
      const currentBatches = onHandIndex.byItemWarehouse.get(key) || [];
      const currentBatchNames = new Set(currentBatches.filter((b) => b.batch).map((b) => b.batch));
      for (const pb of priorBatches) {
        if (!pb.batch) continue;
        if (!currentBatchNames.has(pb.batch)) {
          pushIssue({ severity: "CONFIRM", message: `Batch "${pb.batch}" for "${row.item}" at ${warehouse} was present in the prior on-hand snapshot but is absent from the current one.` });
          continue;
        }
        const cur = currentBatches.find((b) => b.batch === pb.batch);
        if (cur && pb.available > 0 && cur.available < pb.available * 0.8) {
          pushIssue({ severity: "NOTE", message: `Batch "${pb.batch}" for "${row.item}" at ${warehouse} dropped from ${pb.available} to ${cur.available} available between snapshots (>20%) — verify before relying on this allocation.` });
        }
      }
    }
  }

  return {
    table, rowColors, columns: JOURNAL_D_COLUMNS,
    issues: { blocks, confirms, notes },
    ok: blocks.length === 0,
    diagnostics: {
      entity, warehouse, sourceRowCount: extent.rowCount,
      extractedRowCount: extracted.rows.length,
      autoExcludedCount: extracted.autoExcludeCandidates.length,
      manuallyExcludedCount: normalized.excludedRows.length - extracted.autoExcludeCandidates.length,
      journalLineCount: table.length,
      journalQtyTotal, journalAmountTotalSource, excludedQtyTotal, excludedAmountTotalSource,
      sourceQtyTotal: extracted.sourceQtyTotal, sourceAmountTotal: extracted.sourceAmountTotal,
      dateText: dateStr,
      colorCounts: {
        gray: rowColors.filter((c) => c === "gray").length,
        yellow: rowColors.filter((c) => c === "yellow").length,
        red: rowColors.filter((c) => c === "red").length,
        blue: rowColors.filter((c) => c === "blue").length,
      },
    },
    reviewQueue,
    excludedRows: normalized.excludedRows,
    autoExcludeCandidates: extracted.autoExcludeCandidates,
  };
}

// Top-level entry point for one warehouse tab: does the workbook-level prep
// (extent detection, bounded row read, qty-column resolution, Financial-
// impact cell reads) then delegates to reconComputeJournal. workbook/
// sheetName: the loaded reconciliation workbook + the warehouse's tab.
function reconRunForWarehouse(opts) {
  const { workbook, sheetName, entity, warehouse, qtyColumnOverride, onHandIndex } = opts;

  const extent = reconFindTableExtent(workbook, sheetName);
  const preflight = [];
  if (extent.lastDataRow < 0) {
    preflight.push({ severity: "BLOCK", message: `No data found in column B of tab "${sheetName}" from row 4 down.` });
  }
  const rawRows = extent.lastDataRow >= 0 ? io.sheetToRawRowsInRange(workbook, sheetName, 0, extent.lastDataRow) : [];
  const headerVals = (rawRows[RECON_HEADER_ROW] || []).map((v) => (v == null ? "" : String(v).trim()));

  if (extent.lastDataRow >= 0) {
    const whIssue = reconCheckWarehouseColumn(rawRows, extent, warehouse);
    if (whIssue) preflight.push(whIssue);
  }
  if (onHandIndex && !onHandIndex.warehousesPresent.has(warehouse)) {
    preflight.push({ severity: "BLOCK", message: `The on-hand export contains no rows at all for warehouse "${warehouse}".` });
  }

  const qtyResolution = extent.lastDataRow >= 0 ? reconResolveQtyColumn(headerVals, qtyColumnOverride) : { qtyColIndex: null, amountColIndex: null, issue: null, candidates: [] };
  if (qtyResolution.issue) preflight.push(qtyResolution.issue);

  let qtyFinancialImpact = null;
  let amountFinancialImpact = null;
  if (qtyResolution.qtyColIndex != null) {
    qtyFinancialImpact = reconReadFinancialImpact(workbook, sheetName, qtyResolution.qtyColIndex);
    amountFinancialImpact = reconReadFinancialImpact(workbook, sheetName, qtyResolution.amountColIndex);
  }

  const result = reconComputeJournal({
    entity, warehouse, rawRows, extent,
    qtyColIndex: qtyResolution.qtyColIndex, amountColIndex: qtyResolution.amountColIndex,
    journalDate: opts.journalDate, onHandIndex, priorOnHandIndex: opts.priorOnHandIndex,
    aliasMap: opts.aliasMap, exclusionTerms: opts.exclusionTerms,
    qtyFinancialImpact, amountFinancialImpact, nonInteractive: opts.nonInteractive,
    snapshotTimestamp: opts.snapshotTimestamp, extraIssues: preflight,
  });
  result.extent = extent;
  result.qtyResolution = qtyResolution;
  result.qtyFinancialImpact = qtyFinancialImpact;
  result.amountFinancialImpact = amountFinancialImpact;
  return result;
}

// ---------- Reconciliation journal workbook renderer (ExcelJS) ----------
// A dedicated ExcelJS writer (rather than the shared io.toExcelBytes) since
// this output needs formatting toExcelBytes doesn't do: a real Date cell
// with an mm/dd/yyyy number format, live formulas, batch-cell-only fill for
// NOT_BATCH_TRACKED vs whole-row fill for everything else, freeze panes,
// autofilter, and a totals row.
const RECON_FILL = { gray: "FFD9D9D9", yellow: "FFFFEB9C", red: "FFFFC7CE", blue: "FFDDEBF7" };
const RECON_HEADER_FILL = "FF1F4E78";
const RECON_BORDER_COLOR = "FFBFBFBF";
const RECON_THIN_BORDER = { style: "thin", color: { argb: RECON_BORDER_COLOR } };

async function renderReconciliationWorkbook(table, rowColors, sheetTitle) {
  const ExcelJSLib = typeof ExcelJS !== "undefined" ? ExcelJS : require("exceljs");
  const wb = new ExcelJSLib.Workbook();
  const ws = wb.addWorksheet(String(sheetTitle).replace(/[:\\/?*[\]]/g, "-").slice(0, 31));

  ws.columns = JOURNAL_D_COLUMNS.map((c) => ({ header: c, key: c, width: Math.max(12, Math.min(28, c.length + 4)) }));
  const headerRow = ws.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Arial", size: 10 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: RECON_HEADER_FILL } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });

  const dateColIdx = JOURNAL_D_COLUMNS.indexOf("Date") + 1;
  const batchColIdx = JOURNAL_D_COLUMNS.indexOf("Batch number") + 1;
  const qtyColIdx = JOURNAL_D_COLUMNS.indexOf("Quantity") + 1;
  const costAmountColIdx = JOURNAL_D_COLUMNS.indexOf("Cost amount") + 1;

  table.forEach((rowData, idx) => {
    const excelRow = ws.addRow(JOURNAL_D_COLUMNS.map((c) => (rowData[c] === undefined ? null : rowData[c])));
    excelRow.font = { name: "Arial", size: 10 };
    excelRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = { top: RECON_THIN_BORDER, left: RECON_THIN_BORDER, bottom: RECON_THIN_BORDER, right: RECON_THIN_BORDER };
    });
    if (rowData.Date instanceof Date) excelRow.getCell(dateColIdx).numFmt = "mm/dd/yyyy";
    excelRow.getCell(qtyColIdx).numFmt = "#,##0;(#,##0);-";
    excelRow.getCell(costAmountColIdx).numFmt = "#,##0.00;(#,##0.00);-";

    const color = rowColors[idx];
    if (color === "gray") {
      excelRow.getCell(batchColIdx).fill = { type: "pattern", pattern: "solid", fgColor: { argb: RECON_FILL.gray } };
    } else if (color && RECON_FILL[color]) {
      excelRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: RECON_FILL[color] } };
      });
    }
  });

  const totalsRowIdx = table.length + 2;
  const totalsRow = ws.getRow(totalsRowIdx);
  totalsRow.getCell(1).value = "TOTAL";
  if (table.length) {
    totalsRow.getCell(qtyColIdx).value = {
      formula: `SUM(${colLetter(qtyColIdx)}2:${colLetter(qtyColIdx)}${table.length + 1})`,
      result: table.reduce((s, r) => s + toNumSafe(r.Quantity), 0),
    };
    totalsRow.getCell(qtyColIdx).numFmt = "#,##0;(#,##0);-";
    totalsRow.getCell(costAmountColIdx).value = {
      formula: `SUM(${colLetter(costAmountColIdx)}2:${colLetter(costAmountColIdx)}${table.length + 1})`,
      result: 0,
    };
    totalsRow.getCell(costAmountColIdx).numFmt = "#,##0.00;(#,##0.00);-";
  }
  totalsRow.font = { bold: true, name: "Arial", size: 10 };

  ws.views = [{ state: "frozen", ySplit: 1 }];
  if (table.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: table.length + 1, column: JOURNAL_D_COLUMNS.length } };

  return wb.xlsx.writeBuffer();
}

// Browser namespace — app.js calls these as taskD.xxx(...).
if (typeof window !== "undefined") {
  window.taskD = {
    JOURNAL_D_COLUMNS,
    colLetter,
    deriveEntityFromWarehouse,
    findPeriodQuantityColumns,
    buildOnHandIndex,
    buildAgingCostLookup,
    allocateDisposalBatches,
    computeDisposalJournal,
    buildShippedFulfillmentTemplate,
    RECON_STATUS,
    reconCloneEntities,
    colLetterToIndex,
    normalizeQtyHeaderText,
    reconParseDateOnly,
    reconYearMonth,
    reconMonYear,
    reconParseOnHandFilename,
    reconFindTableExtent,
    reconResolveQtyColumn,
    reconCheckWarehouseColumn,
    reconCheckTotalFormulaCoverage,
    reconReadFinancialImpact,
    reconExtractVarianceRows,
    reconNormalize,
    reconBuildOnHandIndex,
    reconAllocateBatches,
    reconComputeJournal,
    reconRunForWarehouse,
    renderReconciliationWorkbook,
  };
}

if (typeof module !== "undefined") {
  const taskC = require("./task_c");
  global.fmtMMDDYYYY = taskC.fmtMMDDYYYY;
  global.io = require("./io_utils");
  module.exports = {
    JOURNAL_D_COLUMNS,
    colLetter,
    deriveEntityFromWarehouse,
    findPeriodQuantityColumns,
    buildOnHandIndex,
    buildAgingCostLookup,
    allocateDisposalBatches,
    computeDisposalJournal,
    buildShippedFulfillmentTemplate,
    RECON_STATUS,
    reconCloneEntities,
    colLetterToIndex,
    normalizeQtyHeaderText,
    reconParseDateOnly,
    reconYearMonth,
    reconMonYear,
    reconParseOnHandFilename,
    reconFindTableExtent,
    reconResolveQtyColumn,
    reconCheckWarehouseColumn,
    reconCheckTotalFormulaCoverage,
    reconReadFinancialImpact,
    reconExtractVarianceRows,
    reconNormalize,
    reconBuildOnHandIndex,
    reconAllocateBatches,
    reconComputeJournal,
    reconRunForWarehouse,
    renderReconciliationWorkbook,
  };
}
