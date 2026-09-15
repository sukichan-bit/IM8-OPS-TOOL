// Task C — Refund/Cancel Order Dispatch Check & Inventory Adjustment.
// Port of refund_cancel_dispatch_check_spec.md.

// ---------- Refund-date resolution (3-tier fallback chain) ----------

function normText(v) {
  return v == null ? "" : String(v).trim().toLowerCase();
}

// Tier 1: "Refunded on" tab — one row per order (via its refund-fee line),
// Sales order -> a date column supplied by the caller. Despite the spec's
// original assumption, this tab's "Ship date" column is NOT the refund date —
// verified against real data it runs consistently ~1 day earlier than
// "Created date and time" in the same row; ops confirmed the latter is
// correct, so callers should pass that column, not "Ship date".
function buildRefundedOnTabLookup(rows, soCol, dateCol) {
  const map = new Map();
  for (const row of rows) {
    const so = row[soCol];
    const date = row[dateCol];
    if (so != null && date != null && !map.has(so)) map.set(so, date);
  }
  return map;
}

// Find a pivot block's filter anchor by scanning for a "Remarks" label cell
// whose neighboring cell (same row, next column) matches the target Remarks
// value. Real layout: label in one column, value in the next.
function findRemarksAnchor(rawRows, remarksValue, maxRows, maxCols) {
  const target = normText(remarksValue);
  const rowLimit = Math.min(maxRows || rawRows.length, rawRows.length);
  for (let r = 0; r < rowLimit; r++) {
    const row = rawRows[r] || [];
    const colLimit = Math.min(maxCols || row.length, row.length);
    for (let c = 0; c < colLimit; c++) {
      if (normText(row[c]) === "remarks" && normText(row[c + 1]) === target) {
        return { row: r, col: c };
      }
    }
  }
  return null;
}

// From a Remarks-filter anchor, find the pivot's actual header row (contains
// "Shopify reference") within a small window below/around the anchor.
function findHeaderRowNear(rawRows, anchor, headerLabel, searchDown, colDrift) {
  searchDown = searchDown || 12;
  colDrift = colDrift || 3;
  const target = normText(headerLabel || "shopify reference");
  for (let r = anchor.row; r < Math.min(anchor.row + searchDown, rawRows.length); r++) {
    const row = rawRows[r] || [];
    for (let c = Math.max(0, anchor.col - colDrift); c < anchor.col + colDrift + 5; c++) {
      if (normText(row[c]) === target) return { row: r, col: c };
    }
  }
  return null;
}

// Read a pivot's header row + data rows given the header anchor (col = where
// "Shopify reference" lives). Reads columns rightward across the entire row
// (bounded by the row's own used-range length) rather than stopping at the
// first run of blank header cells — real pivot exports routinely have a
// second mini pivot (e.g. a "Refund date" table) a few blank spacer columns
// to the right of the main one, and an early stop silently loses it. Blank
// header cells are recorded as null and simply ignored when building rows.
// Data rows downward stop once Shopify reference is blank.
function readPivotTable(rawRows, headerAnchor) {
  const { row: headerRow, col: startCol } = headerAnchor;
  const headers = [];
  for (let c = startCol; c < (rawRows[headerRow] || []).length; c++) {
    const v = rawRows[headerRow][c];
    if (v == null || String(v).trim() === "") {
      headers.push(null);
      continue;
    }
    headers.push(String(v).trim());
  }
  const rows = [];
  for (let r = headerRow + 1; r < rawRows.length; r++) {
    const rawRow = rawRows[r] || [];
    const shopifyRef = rawRow[startCol];
    if (shopifyRef == null || String(shopifyRef).trim() === "") break;
    const obj = {};
    headers.forEach((h, i) => {
      if (h) obj[h] = rawRow[startCol + i];
    });
    rows.push(obj);
  }
  return rows;
}

// Tier 2/3: the Remarks-specific pivot block for a given category (e.g. "Ops -
// to manually fulfil and adjust inventory"). Keyed primarily by Shopify
// reference + Item number, since the same order can have different items
// resolved on different actual dates (e.g. staggered replacement shipments);
// also keeps a ref-only fallback (first row found, order-level) for rows
// whose item can't be matched exactly.
function buildActionsCategoryLookup(rawRows, remarksValue, dateFieldCandidates, statusField) {
  const anchor = findRemarksAnchor(rawRows, remarksValue);
  if (!anchor) return { lookup: new Map(), refOnlyLookup: new Map(), found: false };
  const headerAnchor = findHeaderRowNear(rawRows, anchor);
  if (!headerAnchor) return { lookup: new Map(), refOnlyLookup: new Map(), found: false };
  const pivotRows = readPivotTable(rawRows, headerAnchor);
  const dateField = dateFieldCandidates.find((f) => pivotRows.length && f in pivotRows[0]);
  const map = new Map();
  const refOnlyMap = new Map();
  for (const row of pivotRows) {
    const ref = row["Shopify reference"];
    if (ref == null) continue;
    const date = dateField ? row[dateField] : null;
    if (date == null) continue;
    if (statusField && row[statusField] != null && normText(row[statusField]) !== "fulfilled") continue;
    const item = row["Item number"];
    if (item != null) {
      const key = `${ref}|${item}`;
      if (!map.has(key)) map.set(key, date);
    }
    if (!refOnlyMap.has(ref)) refOnlyMap.set(ref, date);
  }
  return { lookup: map, refOnlyLookup: refOnlyMap, found: true, dateField };
}

// D365 exports a genuinely-unset date as an Excel-epoch-zero placeholder
// (serial ~0, reads back as late Dec 1899) rather than a true blank — must
// be treated as "no date", not a real (wildly wrong) value.
function isPlaceholderDate(v) {
  if (v == null || v === "") return true;
  const d = coerceDate(v);
  return isNaN(d.getTime()) || d.getUTCFullYear() < 2000;
}

// Tier 4: the flat "Workings" sheet (one row per order line, not a pivot) —
// its "R_Shipped Date" column (real column AF) is the actual ship date for
// orders that went through a replacement flow, e.g. "Ops - to cancel Order"
// / "Cancel - Replacement ..." remarks, which tiers 1-3 don't cover (those
// only search the Refund Date tab and the "Ops - refund order"/"Ops - to
// manually fulfil..." pivots specifically).
function buildWorkingsShippedDateLookup(workingsRows, soCol, dateCol) {
  const map = new Map();
  if (!workingsRows || !soCol || !dateCol) return map;
  for (const row of workingsRows) {
    const so = row[soCol];
    const date = row[dateCol];
    if (so == null || isPlaceholderDate(date)) continue;
    if (!map.has(so)) map.set(so, date);
  }
  return map;
}

// Full 4-tier resolver. Returns a function(salesOrder, shopifyRef) -> {date, tier, resolved}.
function buildRefundDateResolver(refundedOnRows, refundedOnCols, actionsRawRows, workingsRows, workingsCols) {
  const tier1 = buildRefundedOnTabLookup(refundedOnRows, refundedOnCols.so, refundedOnCols.date);

  const tier2 = actionsRawRows
    ? buildActionsCategoryLookup(
        actionsRawRows,
        "Ops - to manually fulfil and adjust inventory",
        ["R_shipped date", "Replacement shipped at (UTC)", "Replacement shipped at"],
        "R_Status"
      )
    : { lookup: new Map(), found: false };

  const tier3 = actionsRawRows
    ? buildActionsCategoryLookup(actionsRawRows, "Ops - refund order", ["Refund date", "Refunded on:", "Refunded on"], null)
    : { lookup: new Map(), refOnlyLookup: new Map(), found: false };

  const tier4 = buildWorkingsShippedDateLookup(workingsRows, workingsCols && workingsCols.so, workingsCols && workingsCols.date);

  // item is optional — when supplied, tier 2/3 prefer the exact
  // Shopify-reference+Item-number match (the same order can have different
  // items resolved on different actual dates, e.g. staggered replacement
  // shipments) and only fall back to the order-level (ref-only, first-row)
  // date when that specific item isn't present in the pivot.
  return function resolve(salesOrder, shopifyRef, item) {
    if (salesOrder != null && tier1.has(salesOrder)) {
      return { date: tier1.get(salesOrder), tier: 1, resolved: true };
    }
    if (shopifyRef != null) {
      const key = item != null ? `${shopifyRef}|${item}` : null;
      if (key != null && tier2.lookup.has(key)) {
        return { date: tier2.lookup.get(key), tier: 2, resolved: true };
      }
      if (tier2.refOnlyLookup.has(shopifyRef)) {
        return { date: tier2.refOnlyLookup.get(shopifyRef), tier: 2, resolved: true };
      }
      if (key != null && tier3.lookup.has(key)) {
        return { date: tier3.lookup.get(key), tier: 3, resolved: true };
      }
      if (tier3.refOnlyLookup.has(shopifyRef)) {
        return { date: tier3.refOnlyLookup.get(shopifyRef), tier: 3, resolved: true };
      }
    }
    if (salesOrder != null && tier4.has(salesOrder)) {
      return { date: tier4.get(salesOrder), tier: 4, resolved: true };
    }
    return { date: null, tier: 5, resolved: false };
  };
}

// ---------- SER-line warehouse backfill ----------

function isBlankWarehouse(v) {
  return v == null || String(v).trim() === "";
}

// SER lines frequently have a blank Warehouse even though the rest of their
// order has a real one. Backfill from sibling non-blank lines on the same
// order; flag any order with 0 or 2+ distinct real warehouses rather than
// silently picking one.
function backfillSerWarehouses(rows, soCol, whCol) {
  const bySo = new Map();
  rows.forEach((row, idx) => {
    const so = row[soCol];
    if (!bySo.has(so)) bySo.set(so, []);
    bySo.get(so).push(idx);
  });

  const out = rows.map((r) => ({ ...r }));
  const flagged = [];

  for (const [so, idxs] of bySo.entries()) {
    const warehouses = new Set(
      idxs.map((i) => rows[i][whCol]).filter((v) => !isBlankWarehouse(v)).map((v) => String(v).trim())
    );
    if (warehouses.size === 1) {
      const wh = Array.from(warehouses)[0];
      idxs.forEach((i) => {
        out[i][whCol] = wh;
      });
    } else if (warehouses.size === 0) {
      flagged.push({ salesOrder: so, issue: "no_warehouse", warehouses: [] });
    } else {
      flagged.push({ salesOrder: so, issue: "conflicting_warehouse", warehouses: Array.from(warehouses) });
    }
  }

  return { rows: out, flagged };
}

// ---------- 2-bucket dispatch check (reuses Task B's matching engine) ----------

// Not every source sheet has its date cells recognized by SheetJS's cellDates
// conversion (seen in the real "Refunded on" tab: Ship date comes through as
// a raw Excel serial like 46219, not a Date). new Date(46219) misreads that
// as 46219ms after the JS epoch (1970-01-01) instead of the Excel date it
// represents — so raw numbers must be converted via the Excel serial epoch
// (1899-12-30, serial 25569 = 1970-01-01), not handed to `new Date()` directly.
function coerceDate(v) {
  if (v instanceof Date) return v;
  if (typeof v === "number" && isFinite(v)) {
    return new Date(Math.round((v - 25569) * 86400 * 1000));
  }
  return new Date(v);
}

function fmtMMDDYYYY(v) {
  if (v == null) return "";
  const d = coerceDate(v);
  if (isNaN(d.getTime())) return String(v);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()}`;
}

// refundCancelRows: the SER-backfilled refund/cancel batch rows (ALL original
// columns preserved). cols: {key (prebuilt join key column), item, warehouse,
// qty, shopifyRef, salesOrder}. fulfillmentRows/fulfillmentCols/matchCols:
// passed straight to matchFulfillmentForWarehouse for the underlying 3-way
// match, which gets collapsed to Dispatched/Not Dispatched here.
function computeDispatchCheck(refundCancelRows, cols, fulfillmentRows, fulfillmentCols, refundDateResolver) {
  const matchSoCols = { item: cols.item, warehouse: cols.warehouse, qty: cols.qty, so_number: cols.salesOrder, shopify_ref: cols.shopifyRef };
  const { rows: matched, diagnostics } = matchFulfillmentForWarehouse(refundCancelRows, matchSoCols, fulfillmentRows, fulfillmentCols);

  // Per-order facts (status/tracking/shipped date) from the match, keyed by
  // the same join key — multiple lines per order all carry the same values.
  // order_status (task_b.js's pickStatus) is 3-way: "Shipped" / "Partially
  // Shipped" / "Not Fulfilled" — mapped 1:1 to this tool's own 3-way label.
  const perOrder = new Map();
  for (const r of matched) {
    if (!perOrder.has(r.key)) {
      perOrder.set(r.key, {
        status:
          r.order_status === "Shipped" ? "Dispatched" : r.order_status === "Partially Shipped" ? "Partially Dispatched" : "Not Dispatched",
        tracking_number: r.tracking_number,
        shipped_date: r.shipped_date,
      });
    }
  }

  // Must reproduce the EXACT key basis matchFulfillmentForWarehouse actually
  // used internally (task_b.js), or perOrder.get(key) below silently misses
  // every real match. That function only keys by Sales order number when
  // BOTH sides have one mapped — many warehouse fulfillment reports carry no
  // Sales-order column at all (order-level 3PL exports), which forces it
  // (and therefore this outer re-keying) onto the Shopify-reference key
  // instead, even though the refund/cancel batch itself has a real SO number.
  const canUseSoNumber = !!cols.salesOrder && !!fulfillmentCols.so_number;
  const orderLevelMode = fulfillmentCols.item == null;
  const soKeys = buildJoinKey(refundCancelRows, canUseSoNumber ? cols.salesOrder : null, cols.shopifyRef, orderLevelMode ? null : cols.item);
  const flaggedMultiTracking = new Set(
    matched.filter((r) => r.flag && r.flag.includes("Multiple tracking")).map((r) => r.key)
  );

  const outRows = refundCancelRows.map((row, i) => {
    const key = soKeys[i];
    const info = perOrder.get(key) || { status: "Not Dispatched", tracking_number: null, shipped_date: null };
    const isService = isServiceSku(row[cols.item]);
    const out = { ...row };
    if (info.status !== "Not Dispatched") {
      out.__dispatch_status = info.status; // "Dispatched" or "Partially Dispatched"
      out.__shipped_date_raw = info.shipped_date;
      out["Shipped date"] = fmtMMDDYYYY(info.shipped_date);
      out["Tracking number"] = isService ? "" : info.tracking_number || "";
    } else {
      out.__dispatch_status = "Not Dispatched";
      const rd = refundDateResolver(row[cols.salesOrder], row[cols.shopifyRef], row[cols.item]);
      out.__refund_date_resolution = rd;
      out["Refund Date"] = rd.resolved ? fmtMMDDYYYY(rd.date) : "";
    }
    out.__warehouse = row[cols.warehouse];
    out.__is_service = isService;
    out.__key = key;
    out.__multi_tracking = flaggedMultiTracking.has(key);
    return out;
  });

  // Verification: every Sales order's lines must land in exactly one bucket
  // (same order can't be part-Dispatched/part-Not-Dispatched, since dispatch
  // status is order-level by construction) — check anyway per the spec.
  const orderStatusCheck = new Map();
  const splitOrders = [];
  for (const row of outRows) {
    const so = row[cols.salesOrder];
    if (!orderStatusCheck.has(so)) orderStatusCheck.set(so, row.__dispatch_status);
    else if (orderStatusCheck.get(so) !== row.__dispatch_status) splitOrders.push(so);
  }

  // Not an actual Excel sheet name (never written to a workbook directly —
  // the caller re-splits it on " - " to get warehouse/status back out), so
  // it must never be truncated to Excel's 31-char sheet-name limit here:
  // doing so used to silently mangle "Partially Dispatched" down to
  // "Partially Dispatch", corrupting the status the caller re-parses.
  const perSheet = {};
  const byWarehouseStatus = new Map();
  for (const row of outRows) {
    const sheetKey = `${row.__warehouse} - ${row.__dispatch_status}`;
    if (!byWarehouseStatus.has(sheetKey)) byWarehouseStatus.set(sheetKey, []);
    byWarehouseStatus.get(sheetKey).push(row);
  }
  for (const [sheetKey, rows] of byWarehouseStatus.entries()) {
    perSheet[sheetKey] = rows;
  }

  const unresolvedRefundDates = outRows.filter((r) => r.__dispatch_status === "Not Dispatched" && !r.__refund_date_resolution?.resolved);
  const multiTrackingOrders = outRows.filter((r) => r.__multi_tracking);

  return {
    perSheet,
    rows: outRows,
    diagnostics: {
      ...diagnostics,
      split_across_tabs: Array.from(new Set(splitOrders)),
      unresolved_refund_date_lines: unresolvedRefundDates.length,
      multi_tracking_lines: multiTrackingOrders.length,
    },
  };
}

// ---------- Batch-number lookup (shared by Steps 5/6/7) ----------

// First on-hand row (in file order) with Available physical > 0 for a given
// Item+Warehouse. Blank if the item has no batch recorded at all, or never
// has positive available qty — don't invent one.
function buildBatchLookup(onHandRows, cols) {
  const map = new Map();
  for (const row of onHandRows) {
    const key = `${row[cols.item]}|${row[cols.warehouse]}`;
    if (map.has(key)) continue;
    const avail = toNumSafe(row[cols.available]);
    const batch = row[cols.batch];
    if (avail > 0 && batch != null && String(batch).trim() !== "") map.set(key, String(batch).trim());
  }
  return map;
}

function toNumSafe(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return isNaN(n) ? 0 : n;
}

// ---------- Steps 5 & 7: D365 fulfillment template (one row per unit) ----------

// rows: dispatch-checked rows filtered to one status bucket already.
// dateFn(row) -> "Shipped date" text; awbFn(row, isService) -> AWB text;
// batchLookupFn(item, warehouse) -> batch number or "".
function buildFulfillmentTemplateRows(rows, cols, dateFn, awbFn, batchLookupFn) {
  const out = [];
  const multiTracking = [];
  for (const row of rows) {
    const qty = toNumSafe(row[cols.qty]);
    if (qty <= 0) continue;
    const isService = isServiceSku(row[cols.item]);
    const warehouse = row.__warehouse != null ? row.__warehouse : row[cols.warehouse];
    const warehouseLocation = isService ? "Prenetics~~" : `Prenetics~${warehouse}~Primary`;
    const batch = isService ? "" : batchLookupFn(row[cols.item], warehouse) || "";
    const shippedDate = dateFn(row);
    const awb = awbFn(row, isService);
    if (row.__multi_tracking) multiTracking.push(row[cols.salesOrder]);
    for (let u = 0; u < Math.round(qty); u++) {
      out.push({
        "Shipped date": shippedDate,
        "Order ID": row[cols.salesOrder],
        AWB: awb,
        "SKU Number": row[cols.item],
        "Warehouse location": warehouseLocation,
        "Batch Number": batch,
      });
    }
  }
  return { rows: out, multiTrackingOrders: Array.from(new Set(multiTracking)) };
}

// ---------- Step 6: inventory adjustment journal ----------

const JOURNAL_COLUMNS = [
  "Date", "Item number", "Product name", "Manufacturer information", "Style", "Site",
  "Warehouse", "Batch number", "Location", "CW quantity", "CW unit", "Quantity",
  "Unit quantity", "Unit", "Cost price", "Cost amount", "Batch disposition code",
  "Batch disposition status", "Disposal reason", "Disposal reason description",
  "Reject reason", "Reject reason description",
];

function monthKey(dateVal) {
  const d = coerceDate(dateVal);
  if (isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function isCurrentMonth(key, todayDate) {
  return key === monthKey(todayDate);
}

// costLookup(item, warehouse) -> {cost, unit} or null (from the aging report).
// bundleCompositions: {bundleSku: [{sku, qty}, ...]} — user-maintained, used
// only when the bundle's own aging-report cost is $0/missing.
function computeInventoryJournal(notDispatchedRows, cols, costLookup, bundleCompositions, todayDate) {
  const fgRows = notDispatchedRows.filter((r) => !isServiceSku(r[cols.item]) && toNumSafe(r[cols.qty]) > 0);

  // Group by warehouse, then by refund-date month.
  const byWarehouse = new Map();
  for (const row of fgRows) {
    const wh = row.__warehouse != null ? row.__warehouse : row[cols.warehouse];
    if (!byWarehouse.has(wh)) byWarehouse.set(wh, []);
    byWarehouse.get(wh).push(row);
  }

  const files = []; // { warehouse, monthKey, dateUsed, isPastMonthDefaulted, table }
  const unresolvedCosts = [];
  const unresolvedBundles = [];

  for (const [warehouse, rowsForWh] of byWarehouse.entries()) {
    const byMonth = new Map();
    for (const row of rowsForWh) {
      const refundDateRaw = row.__refund_date_resolution ? row.__refund_date_resolution.date : null;
      const mk = refundDateRaw ? monthKey(refundDateRaw) : "unknown";
      if (!byMonth.has(mk)) byMonth.set(mk, []);
      byMonth.get(mk).push({ ...row, __refund_date_raw: refundDateRaw });
    }

    for (const [mk, monthRows] of byMonth.entries()) {
      let dateUsed, isPastMonthDefaulted = false;
      if (mk === "unknown") {
        dateUsed = todayDate;
      } else if (isCurrentMonth(mk, todayDate)) {
        dateUsed = todayDate;
      } else {
        // Past month: spec says "ask the person" — default to the latest
        // refund date in the group and flag it clearly for confirmation.
        const dates = monthRows.map((r) => r.__refund_date_raw).filter(Boolean).map((d) => coerceDate(d));
        dateUsed = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : todayDate;
        isPastMonthDefaulted = true;
      }

      // Aggregate by Item number.
      const byItem = new Map();
      for (const row of monthRows) {
        const item = row[cols.item];
        if (!byItem.has(item)) byItem.set(item, { item, qty: 0, productName: row[cols.productName], rows: [] });
        const entry = byItem.get(item);
        entry.qty += toNumSafe(row[cols.qty]);
        entry.rows.push(row);
      }

      // Items with no resolvable cost stay in this SAME table/file, right
      // alongside items whose cost did resolve — never split into a separate
      // workbook. Only the Cost price/Cost amount cells for that one row are
      // left blank (not 0, which would misrepresent "confirmed zero cost").
      const table = [];
      for (const { item, qty, productName } of byItem.values()) {
        const batch = costLookup.batchLookup(item, warehouse) || "";
        let costInfo = costLookup.costLookup(item, warehouse);
        let costResolved = !!(costInfo && costInfo.cost);
        if (!costResolved) {
          const composition = bundleCompositions && bundleCompositions[item];
          if (composition) {
            let total = 0;
            let allResolved = true;
            for (const comp of composition) {
              const compCost = costLookup.costLookup(comp.sku, warehouse);
              if (!compCost || !compCost.cost) {
                allResolved = false;
                break;
              }
              total += compCost.cost * comp.qty;
            }
            if (allResolved) {
              costInfo = { cost: total, unit: costInfo ? costInfo.unit : null };
              costResolved = true;
            } else {
              unresolvedBundles.push({ item, warehouse, reason: "component cost missing from aging report" });
              costInfo = { cost: null, unit: costInfo ? costInfo.unit : null };
            }
          } else {
            unresolvedCosts.push({ item, warehouse });
            costInfo = { cost: null, unit: costInfo ? costInfo.unit : null };
          }
        }
        const unit = costInfo.unit || costLookup.unitLookup(item) || "";
        const costPrice = costResolved ? costInfo.cost : null;
        table.push({
          Date: fmtMMDDYYYY(dateUsed),
          "Item number": item,
          "Product name": productName || "",
          "Manufacturer information": costLookup.manufacturerLookup ? costLookup.manufacturerLookup(item) || "" : "",
          Style: "",
          Site: "Prenetics",
          Warehouse: warehouse,
          "Batch number": batch,
          Location: "Primary",
          "CW quantity": 0,
          "CW unit": "",
          Quantity: qty,
          "Unit quantity": qty,
          Unit: unit,
          "Cost price": costPrice == null ? "" : costPrice,
          "Cost amount": costPrice == null ? "" : qty * costPrice,
          "Batch disposition code": "",
          "Batch disposition status": "",
          "Disposal reason": "",
          "Disposal reason description": "",
          "Reject reason": "",
          "Reject reason description": "",
        });
      }
      files.push({ warehouse, monthKey: mk, dateUsed: fmtMMDDYYYY(dateUsed), isPastMonthDefaulted, table });
    }
  }

  return { files, unresolvedCosts, unresolvedBundles, columns: JOURNAL_COLUMNS };
}

// Browser namespace — app.js calls these as taskC.xxx(...).
if (typeof window !== "undefined") {
  window.taskC = {
    normText,
    buildRefundedOnTabLookup,
    findRemarksAnchor,
    findHeaderRowNear,
    readPivotTable,
    buildActionsCategoryLookup,
    buildRefundDateResolver,
    buildBatchLookup,
    buildFulfillmentTemplateRows,
    computeInventoryJournal,
    JOURNAL_COLUMNS,
    backfillSerWarehouses,
    computeDispatchCheck,
    fmtMMDDYYYY,
    monthKey,
    buildWorkingsShippedDateLookup,
    isPlaceholderDate,
  };
}

if (typeof module !== "undefined") {
  const taskB = require("./task_b");
  global.matchFulfillmentForWarehouse = taskB.matchFulfillmentForWarehouse;
  global.buildJoinKey = taskB.buildJoinKey;
  global.isServiceSku = require("./sku_rules").isServiceSku;
  module.exports = {
    normText,
    buildRefundedOnTabLookup,
    findRemarksAnchor,
    findHeaderRowNear,
    readPivotTable,
    buildActionsCategoryLookup,
    buildRefundDateResolver,
    buildBatchLookup,
    buildFulfillmentTemplateRows,
    computeInventoryJournal,
    JOURNAL_COLUMNS,
    backfillSerWarehouses,
    computeDispatchCheck,
    fmtMMDDYYYY,
    monthKey,
    buildWorkingsShippedDateLookup,
    isPlaceholderDate,
  };
}
