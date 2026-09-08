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
  };
}

if (typeof module !== "undefined") {
  const taskC = require("./task_c");
  global.fmtMMDDYYYY = taskC.fmtMMDDYYYY;
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
  };
}
