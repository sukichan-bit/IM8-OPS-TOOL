// Task A — Production Requirement Report. Port of lib/task_a.py.
// To produce = MAX(Requested qty - On-hand qty - On-order qty, 0), grouped by (Item, Warehouse).

const TOTALS_LABEL = "TOTAL";

// Per production_shortfall_report_spec.md: this SKU has historically been
// absent from some on-hand exports; use this name without flagging as long
// as the SKU has at least one on-hand row somewhere (the "verify item
// master" flag below is about trusting the on-hand qty, not the name).
const KNOWN_NAME_OVERRIDES = {
  "IM8-FG-000161": "Quarterly Subscription - Longevity Starter",
  "IM8-FG-000166": "Quarterly Subscription - Longevity Refill",
};

// Fixed display order for the per-warehouse report sections (not data-
// dependent insertion order). Any warehouse code not in this list still
// appears — just after the known ones, sorted alphabetically — so nothing
// is silently dropped if a new warehouse code shows up.
const WAREHOUSE_ORDER = ["OPS-WH01", "OPS-WH02", "OPS-WH03", "USOPS-WH04", "USOPS-WH05"];

function warehouseSortKey(wh) {
  const idx = WAREHOUSE_ORDER.indexOf(wh);
  return idx === -1 ? [1, wh] : [0, idx];
}

function compareWarehouses(a, b) {
  const ka = warehouseSortKey(a);
  const kb = warehouseSortKey(b);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  if (ka[0] === 0) return ka[1] - kb[1];
  return ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0;
}

function groupSum(rows, keyFn, valFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    map.set(key, (map.get(key) || 0) + (valFn(row) || 0));
  }
  return map;
}

function toNum(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function isBlank(v) {
  return v == null || String(v).trim() === "";
}

// onorderRows/onorderCols: optional D365 on-order (incoming/in-production)
// export — {item, warehouse, qty} — added to on-hand when computing To
// produce, so already-incoming stock isn't double-counted as a shortfall.
// Omit both to keep the plain Requested-vs-On-hand behavior. extraNameMap:
// optional {item: productName} auto-extracted from another flat sheet in
// the same requested-inventory workbook (e.g. a full "SO" tab) — covers
// SKUs with zero on-hand rows, which the on-hand file itself can never
// name. itemMaster: optional {item: productName} lookup (e.g. a saved
// Released-Items master) used only to backfill Product name for SKUs
// still missing one after the above.
function computeProductionRequirement(requestedRows, onhandRows, requestedCols, onhandCols, showAllRows, onorderRows, onorderCols, itemMaster, extraNameMap) {
  const diagnostics = {};
  const haveOnorder = !!(onorderRows && onorderCols);
  diagnostics.requested_rows_in = requestedRows.length;
  diagnostics.onhand_rows_in = onhandRows.length;

  let req = requestedRows.map((r) => ({
    item: normalizeSku(r[requestedCols.item]),
    warehouse: r[requestedCols.warehouse],
    qty: toNum(r[requestedCols.qty]),
  }));
  const hasProductName = onhandCols.product_name && onhandRows.length && onhandCols.product_name in onhandRows[0];
  let onh = onhandRows.map((r) => ({
    item: normalizeSku(r[onhandCols.item]),
    warehouse: r[onhandCols.warehouse],
    available: toNum(r[onhandCols.available]),
    product_name: hasProductName ? r[onhandCols.product_name] : null,
  }));

  const reqBeforeExcl = req.length;
  const onhBeforeExcl = onh.length;
  req = req.filter((r) => !isExcludedSku(r.item));
  onh = onh.filter((r) => !isExcludedSku(r.item));
  diagnostics.requested_excluded_sku_rows = reqBeforeExcl - req.length;
  diagnostics.onhand_excluded_sku_rows = onhBeforeExcl - onh.length;

  const beforeBlankWh = req.length;
  req = req.filter((r) => !isBlank(r.warehouse));
  diagnostics.requested_blank_warehouse_dropped = beforeBlankWh - req.length;

  const key = (r) => `${r.item} ${r.warehouse}`;
  const reqAggMap = groupSum(req, key, (r) => r.qty);
  const onhAggMap = groupSum(onh, key, (r) => r.available);

  let onorAggMap = new Map();
  if (haveOnorder) {
    let onor = onorderRows.map((r) => ({
      item: normalizeSku(r[onorderCols.item]),
      warehouse: r[onorderCols.warehouse],
      onorder: toNum(r[onorderCols.qty]),
    }));
    diagnostics.onorder_rows_in = onor.length;
    const onorBeforeExcl = onor.length;
    onor = onor.filter((r) => !isExcludedSku(r.item));
    diagnostics.onorder_excluded_sku_rows = onorBeforeExcl - onor.length;
    onorAggMap = groupSum(onor, key, (r) => r.onorder);
  }

  const productNames = new Map();
  if (hasProductName) {
    for (const r of onh) {
      if (r.product_name != null && !productNames.has(r.item)) productNames.set(r.item, r.product_name);
    }
  }
  // Only flag-as-missing when the SKU has literally zero rows anywhere in
  // the on-hand export — a real but currently-zero on-hand row is a
  // legitimate 0, not a reason to distrust it.
  const presentInOnhand = new Set(onh.map((r) => r.item));

  let merged = [];
  for (const k of reqAggMap.keys()) {
    const [item, warehouse] = k.split(" ");
    const qty = reqAggMap.get(k);
    const available = onhAggMap.get(k) || 0;
    const onorder = onorAggMap.get(k) || 0;
    const toProduce = Math.max(qty - available - onorder, 0);
    // Incoming/in-production qty beyond what's needed for the currently-known
    // shortfall — a potential over-ordering signal, not itself a shortfall.
    const extraOnOrder = haveOnorder ? Math.max(onorder - toProduce, 0) : 0;
    const productName =
      (hasProductName && productNames.get(item)) ||
      (extraNameMap && extraNameMap[item]) ||
      KNOWN_NAME_OVERRIDES[item] ||
      (itemMaster && itemMaster[item]) ||
      "";
    merged.push({
      item,
      warehouse,
      product_name: productName,
      verify_item_master: !presentInOnhand.has(item),
      qty,
      available,
      onorder,
      to_produce: toProduce,
      extra_on_order: extraOnOrder,
    });
  }

  if (!showAllRows) merged = merged.filter((r) => r.to_produce > 0);

  diagnostics.output_rows = merged.length;
  diagnostics.warehouses = Array.from(new Set(merged.map((r) => r.warehouse))).sort(compareWarehouses);

  const perWarehouse = {};
  const byWarehouse = new Map();
  for (const r of merged) {
    if (!byWarehouse.has(r.warehouse)) byWarehouse.set(r.warehouse, []);
    byWarehouse.get(r.warehouse).push(r);
  }
  const orderedWarehouses = Array.from(byWarehouse.keys()).sort(compareWarehouses);
  for (const wh of orderedWarehouses) {
    const group = byWarehouse.get(wh);
    // Items needing production come first, then fully-covered items — A-Z
    // within each of those two groups.
    group.sort((a, b) => {
      const aNeeds = a.to_produce > 0 ? 0 : 1;
      const bNeeds = b.to_produce > 0 ? 0 : 1;
      if (aNeeds !== bNeeds) return aNeeds - bNeeds;
      return a.item < b.item ? -1 : a.item > b.item ? 1 : 0;
    });
    const table = group.map((r) => {
      const row = {
        "Item number": r.item,
        "Product name": r.product_name,
        "Requested qty": r.qty,
        "On-hand qty": r.available,
      };
      if (haveOnorder) row["On-order qty"] = r.onorder;
      row["To produce"] = r.to_produce;
      if (haveOnorder) row["Extra on order"] = r.extra_on_order;
      row["Flag"] = r.verify_item_master ? "Verify item master" : "";
      return row;
    });
    const totals = {
      "Item number": TOTALS_LABEL,
      "Product name": "",
      "Requested qty": table.reduce((s, r) => s + r["Requested qty"], 0),
      "On-hand qty": table.reduce((s, r) => s + r["On-hand qty"], 0),
    };
    if (haveOnorder) totals["On-order qty"] = table.reduce((s, r) => s + r["On-order qty"], 0);
    totals["To produce"] = table.reduce((s, r) => s + r["To produce"], 0);
    if (haveOnorder) totals["Extra on order"] = table.reduce((s, r) => s + r["Extra on order"], 0);
    totals["Flag"] = "";
    table.push(totals);
    perWarehouse[wh] = table;
  }

  return { perWarehouse, diagnostics };
}

// ---------- Requested-demand pivot extraction (Action/Actions tab) ----------

// Per production_shortfall_report_spec.md: the authoritative requested-qty
// source is a pre-built Excel PivotTable embedded in the Open SO workbook's
// "Action"/"Actions" tab (Item number rows x Warehouse columns, "Sum of
// Quantity", already filtered to Remarks="IT - to rerun fulfillment" + SO
// Status="Open order"). A naive re-derivation by filtering the raw flat
// SO-line sheet by Remarks and summing Quantity gave a MATERIALLY different
// (and wrong — ~3-4x too high) total in practice, confirmed against a real
// reference report: this pivot's cache draws from a different underlying
// scope than the flat sheet, so it must be read as-is, never recomputed.
function findRowLabelsAnchor(rawRows) {
  for (let r = 0; r < rawRows.length; r++) {
    const row = rawRows[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (String(row[c] == null ? "" : row[c]).trim().toLowerCase() === "row labels") {
        return { row: r, col: c };
      }
    }
  }
  return null;
}

// Returns null if no "Row Labels" pivot anchor is found (caller should fall
// back to flat-file handling) — not an error, just "this isn't that shape".
function extractItemWarehousePivot(rawRows) {
  const anchor = findRowLabelsAnchor(rawRows);
  if (!anchor) return null;

  const headerRow = rawRows[anchor.row] || [];
  const warehouses = [];
  for (let c = anchor.col + 1; c < headerRow.length; c++) {
    const v = headerRow[c];
    const text = v == null ? "" : String(v).trim();
    if (!text || /^grand total$/i.test(text)) break;
    warehouses.push({ name: text, col: c });
  }

  const items = [];
  let grandTotalRow = null;
  for (let r = anchor.row + 1; r < rawRows.length; r++) {
    const row = rawRows[r] || [];
    const label = row[anchor.col];
    if (label == null || String(label).trim() === "") break;
    if (String(label).trim().toLowerCase() === "grand total") {
      grandTotalRow = row;
      break;
    }
    const entry = { item: String(label).trim(), values: {} };
    for (const wh of warehouses) {
      const v = row[wh.col];
      entry.values[wh.name] = typeof v === "number" ? v : v == null || v === "" ? 0 : toNum(v);
    }
    items.push(entry);
  }

  const validation = { mismatches: [] };
  if (grandTotalRow) {
    for (const wh of warehouses) {
      const expected = typeof grandTotalRow[wh.col] === "number" ? grandTotalRow[wh.col] : toNum(grandTotalRow[wh.col]);
      const actual = items.reduce((s, it) => s + it.values[wh.name], 0);
      if (Math.abs(actual - expected) > 1e-6) validation.mismatches.push({ warehouse: wh.name, expected, actual });
    }
  } else {
    validation.mismatches.push({ warehouse: null, reason: "no Grand Total row found beneath the pivot — could not validate" });
  }

  return { warehouses: warehouses.map((w) => w.name), items, validation };
}

// Reshapes the pivot into flat {Item number, Warehouse, Quantity} rows
// consumable by the existing computeProductionRequirement (same rows/cols
// contract as the flat-file path) — zero/blank cells are skipped rather than
// emitted as zero-qty rows, since they carry no demand.
function pivotToFlatRequestedRows(pivot) {
  const rows = [];
  for (const entry of pivot.items) {
    for (const wh of pivot.warehouses) {
      const qty = entry.values[wh];
      if (qty) rows.push({ "Item number": entry.item, Warehouse: wh, Quantity: qty });
    }
  }
  return rows;
}

// ---------- Item -> Product name backfill from another flat sheet ----------

// Scans every sheet in a workbook for one with BOTH an Item-number-like
// and a Product-name-like column (e.g. a full "SO" tab listing every line
// ever ordered, present in the same workbook as the Action-tab pivot
// above) and merges them into one {item: productName} map — a free,
// comprehensive name source straight from data the user already
// uploaded, so a SKU with zero rows in the on-hand export (which can
// never carry its own name) still shows its real Product name instead of
// a blank cell. First sheet to name a given item wins; a sheet that
// doesn't have both columns (or fails to parse) is just skipped, never
// throws.
function extractItemNameMapFromWorkbook(wb) {
  const map = {};
  const sheets = io.listSheets(wb) || [];
  for (const sheetName of sheets) {
    let rows;
    try {
      const raw = io.sheetToRawRows(wb, sheetName, 15);
      const guess = io.guessHeaderRowAndScore(raw, { item: ["item number", "sku"], name: ["product name"] });
      rows = io.loadTableFromSheet(wb, sheetName, guess.row);
    } catch (e) {
      continue;
    }
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    const itemCol = io.fuzzyMatchColumn(cols, ["item number", "sku"]);
    const nameCol = io.fuzzyMatchColumn(cols, ["product name"]);
    if (!itemCol || !nameCol) continue;
    for (const r of rows) {
      const item = r[itemCol];
      const name = r[nameCol];
      if (item == null || String(item).trim() === "") continue;
      if (name == null || String(name).trim() === "") continue;
      const key = String(item).trim();
      if (!map[key]) map[key] = String(name).trim();
    }
  }
  return map;
}

if (typeof window !== "undefined") {
  window.taskA = {
    ...(window.taskA || {}),
    computeProductionRequirement,
    extractItemWarehousePivot,
    pivotToFlatRequestedRows,
    extractItemNameMapFromWorkbook,
  };
}

if (typeof module !== "undefined") {
  const skuRules = require("./sku_rules");
  global.normalizeSku = skuRules.normalizeSku;
  global.isExcludedSku = skuRules.isExcludedSku;
  global.io = require("./io_utils");
  module.exports = {
    computeProductionRequirement,
    extractItemWarehousePivot,
    pivotToFlatRequestedRows,
    extractItemNameMapFromWorkbook,
  };
}
