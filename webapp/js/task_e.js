// Task E — TikTok Transactions -> D365 Sales Order Lines.
// Port of TikTok_to_D365_SO_Workflow.md.
//
// Source file layout varies by region AND can change month to month (the
// spec is explicit about this) — extraction is therefore driven entirely by
// user-supplied cell ranges/column letters/row numbers, never hardcoded
// per-region parsing logic. Only the STABLE parts of the spec (line-building
// rules, template field defaults, sign conventions, reconciliation) are
// baked in here.

// ---------- Excel column-letter <-> index helpers ----------

function colIndexFromLetter(letters) {
  const s = String(letters || "").trim().toUpperCase();
  let n = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0) - 64;
    if (c < 1 || c > 26) return null;
    n = n * 26 + c;
  }
  return s ? n - 1 : null; // 0-based
}

function colLetterFromIndex(idx) {
  let n = idx + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function toNumSafe(v) {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/[,$]/g, ""));
  return isNaN(n) ? 0 : n;
}

function isBlankRow(row) {
  return !row || row.every((v) => v == null || String(v).trim() === "");
}

// ---------- Region defaults (spec step 2) ----------

const REGION_DEFAULTS = {
  "HK/Global": { warehouse: "USOPS-WH07", location: "Primary" },
  US: { warehouse: "USOPS-WH07", location: "Primary" },
  UK: { warehouse: "OPS-WH04", location: "Primary" },
};

// ---------- Template field defaults (spec step 4) ----------

const TEMPLATE_FIELD_DEFAULTS = {
  "Adjusted unit price": 0,
  "Adjusted net amount": 0,
  "Delivery type": "Stock",
  Site: "Prenetics",
  Currency: "USD",
  "Line status": "Invoiced",
  "Line type": "Regular",
  "Same batch selection": "No",
  "Fulfillment status": "Unknown",
  "DOM Status": "Not processed",
};

const SO_LINE_COLUMNS = [
  "Item number", "Product name", "Warehouse", "Location", "Unit price", "Discount",
  "Quantity", "Net amount", "Adjusted unit price", "Adjusted net amount",
  "Delivery type", "Site", "Currency", "Line status", "Line type",
  "Same batch selection", "Fulfillment status", "DOM Status",
];

// ---------- Generic row-wise table extraction ----------

// rawRows: full sheetToRawRows() 2D array (0-indexed). range: {startRow,
// endRow} are 1-based Excel row numbers (as the user reads them off-screen)
// or null to mean "from here to the first fully-blank row" / "from the first
// non-blank row". cols: {roleName: "ColumnLetter", ...} — only the sku
// column is required; a row with a blank value there is skipped (it's
// treated as the true end of the table, matching how these hand-built pivot
// exports usually trail off into blank padding rows).
function extractRowRecords(rawRows, range, cols) {
  const colIdx = {};
  for (const [role, letter] of Object.entries(cols)) {
    if (letter == null || letter === "") continue;
    colIdx[role] = colIndexFromLetter(letter);
  }
  if (colIdx.sku == null) throw new Error("extractRowRecords: a SKU/item column letter is required");

  const startRow0 = range.startRow != null ? range.startRow - 1 : 0;
  const endRow0 = range.endRow != null ? range.endRow - 1 : rawRows.length - 1;

  const records = [];
  const skippedBlank = [];
  for (let r = startRow0; r <= endRow0 && r < rawRows.length; r++) {
    const row = rawRows[r] || [];
    const skuVal = row[colIdx.sku];
    if (skuVal == null || String(skuVal).trim() === "") {
      skippedBlank.push(r + 1);
      continue;
    }
    const rec = { __row: r + 1 };
    for (const [role, idx] of Object.entries(colIdx)) {
      rec[role] = row[idx];
    }
    records.push(rec);
  }
  return { records, skippedBlankRows: skippedBlank };
}

// ---------- US-style transposed fee table (spec: fees=row, item codes=row) ----------

// colRange: {startCol, endCol} as Excel column letters. Each column between
// them is one fee TYPE; feeTypeRow/itemCodeRow/amountRow are 1-based row
// numbers within the sheet holding, respectively, the fee name, the mapped
// D365 item code, and the dollar total for that fee column.
function extractTransposedFeeRecords(rawRows, opts) {
  const startCol = colIndexFromLetter(opts.startCol);
  const endCol = colIndexFromLetter(opts.endCol);
  const feeTypeRow = rawRows[opts.feeTypeRow - 1] || [];
  const itemCodeRow = rawRows[opts.itemCodeRow - 1] || [];
  const amountRow = rawRows[opts.amountRow - 1] || [];

  const records = [];
  for (let c = startCol; c <= endCol; c++) {
    const feeType = feeTypeRow[c];
    if (feeType == null || String(feeType).trim() === "") continue;
    records.push({
      __col: colLetterFromIndex(c),
      feeType: String(feeType).trim(),
      itemCode: itemCodeRow[c] == null ? null : String(itemCodeRow[c]).trim(),
      amount: amountRow[c],
    });
  }
  return records;
}

// ---------- US "Summary" sheet auto-detection ----------
// The US region's "Summary" tab has a stable two-part structure, located
// entirely by label text (never fixed row/column numbers, since row counts
// vary month to month with the number of SKUs sold and which fee columns
// are non-zero):
//   1. A top pivot: "Row Labels" header row, a "Grand Total" row, then (the
//      very next row) an item-code mapping row and (the row after that) a
//      fee-name row — one column per fee type. The "Sum of Net sales" and
//      "Sum of Net earnings" columns are the two landmarks; every other
//      "Sum of ..." column between them is a candidate fee/SER line if the
//      item-code row has a mapping for it.
//   2. A lower per-SKU sales table: "Seller SKU" header row, one row per
//      price tier (a blank Seller SKU cell means "same SKU as the row
//      above" — Excel's own pivot never repeats the label down a group),
//      "<SKU> Total" subtotal rows (already reflected by their own group's
//      data rows, so skipped rather than double-counted), ending at its
//      own "Grand Total" row.
// The gap between this table's own Net-sales Grand Total and the top
// pivot's Net-sales Grand Total is the period's refund amount (the top
// pivot's "Net sales" already nets refunds out; this table's doesn't).
const US_REFUND_ITEM_CODE = "IM8-SER-000005";

// D365's own spelling per SER item code — the sheet's own mapping-row text
// (e.g. "S&D - Commission") is a fallback only for a code not seeded here.
const US_SER_NAME_SEED = {
  "IM8-SER-000013": "Commission expense",
  "IM8-SER-000023": "Fulfillment fees",
  "IM8-SER-000002": "Payment Gateway Fees",
  "IM8-SER-000005": "Refund",
};

function findLabelRow(rawRows, colIdx, text) {
  const needle = String(text).trim().toLowerCase();
  for (let r = 0; r < rawRows.length; r++) {
    const cell = rawRows[r] && rawRows[r][colIdx];
    if (cell != null && String(cell).trim().toLowerCase() === needle) return r;
  }
  return -1;
}

function findHeaderCol(headerRow, text) {
  const needle = String(text).trim().toLowerCase();
  for (let c = 0; c < headerRow.length; c++) {
    const cell = headerRow[c];
    if (cell != null && String(cell).trim().toLowerCase().includes(needle)) return c;
  }
  return -1;
}

// Returns null (never throws) if the expected landmarks aren't found, so
// the caller can fall back to the manual sheet/range/column configuration
// UI for a file that doesn't match this shape.
function autoDetectUsSummaryTable(rawRows) {
  const headerRow0 = findLabelRow(rawRows, 0, "row labels");
  const topGrandRow0 = findLabelRow(rawRows, 0, "grand total");
  if (headerRow0 < 0 || topGrandRow0 < 0 || topGrandRow0 <= headerRow0) return null;

  const headerRow = rawRows[headerRow0] || [];
  const grandRow = rawRows[topGrandRow0] || [];
  const codeRow = rawRows[topGrandRow0 + 1] || [];
  const nameRow = rawRows[topGrandRow0 + 2] || [];

  const netSalesCol = findHeaderCol(headerRow, "net sales");
  const netEarningsCol = findHeaderCol(headerRow, "net earnings");
  if (netSalesCol < 0 || netEarningsCol < 0) return null;

  const feeRecords = [];
  for (let c = netSalesCol + 1; c < headerRow.length; c++) {
    if (c === netEarningsCol) continue;
    const label = headerRow[c];
    if (label == null || String(label).trim() === "") continue;
    const itemCode = codeRow[c] == null ? null : String(codeRow[c]).trim();
    if (!itemCode) continue; // no D365 mapping for this fee column — nothing to emit
    // Prefer the D365-side name seed (its own spelling, e.g. "Commission
    // expense") over the sheet's own mapping-row text (e.g. "S&D -
    // Commission") — same item code can carry either depending on the
    // sheet's own labeling, but the D365 side is what should show up as
    // "Product name" on the SO line.
    const sheetLabel = nameRow[c] == null ? String(label).trim() : String(nameRow[c]).trim();
    feeRecords.push({
      feeType: US_SER_NAME_SEED[itemCode] || sheetLabel,
      itemCode,
      amount: grandRow[c],
    });
  }
  const topNetSales = toNumSafe(grandRow[netSalesCol]);
  const netEarnings = toNumSafe(grandRow[netEarningsCol]);

  // ---- Lower per-SKU sales table ----
  const skuHeaderRow0 = findLabelRow(rawRows, 0, "seller sku");
  if (skuHeaderRow0 < 0 || skuHeaderRow0 <= topGrandRow0) return null;
  const skuHeaderRow = rawRows[skuHeaderRow0] || [];
  const qtyCol = findHeaderCol(skuHeaderRow, "sold quantity");
  const salesCol = findHeaderCol(skuHeaderRow, "net sales");
  if (qtyCol < 0 || salesCol < 0) return null;
  const costCol = 1; // "Unit Cost (Sales)" — always the column right after "Seller SKU"

  const itemRecords = [];
  let currentSku = null;
  let bottomGrandRow0 = -1;
  for (let r = skuHeaderRow0 + 1; r < rawRows.length; r++) {
    const row = rawRows[r] || [];
    const label = row[0];
    if (label != null && String(label).trim() !== "") {
      const text = String(label).trim();
      if (text.toLowerCase() === "grand total") { bottomGrandRow0 = r; break; }
      if (/\stotal$/i.test(text)) continue; // subtotal row — already reflected in its own group's data rows
      currentSku = text;
    } else if (currentSku == null) {
      continue;
    }
    const qty = row[qtyCol];
    const sales = row[salesCol];
    if (qty == null || sales == null) continue;
    itemRecords.push({ __row: r + 1, sku: currentSku, productName: null, unitPrice: row[costCol], discount: 0, qty });
  }
  if (bottomGrandRow0 < 0) return null;
  const bottomNetSales = toNumSafe((rawRows[bottomGrandRow0] || [])[salesCol]);
  if (!itemRecords.length) return null;

  // The FG lines below come from this table's own (gross, not refund-netted)
  // numbers, so the gap vs. the top pivot's (already refund-netted) Net
  // sales must be booked as its own deduction line — hence the sign flip.
  const refundAmount = Math.round((topNetSales - bottomNetSales) * 100) / 100;
  const refundLine = Math.abs(refundAmount) >= 0.005
    ? { feeType: US_SER_NAME_SEED[US_REFUND_ITEM_CODE], itemCode: US_REFUND_ITEM_CODE, amount: refundAmount }
    : null;

  return {
    itemRecords,
    feeRecords,
    refundLine,
    referenceTotal: netEarnings,
    diagnostics: {
      headerRow: headerRow0 + 1, topGrandRow: topGrandRow0 + 1, skuHeaderRow: skuHeaderRow0 + 1,
      bottomGrandRow: bottomGrandRow0 + 1, topNetSales, bottomNetSales, netEarnings, refundAmount,
    },
  };
}

// records: {feeType, itemCode, amount}. Unlike buildFeeLines (which infers
// +1-vs-−1 from the fee-type TEXT, per the original per-region spec), the
// auto-detected US Summary pivot's own Grand Total already carries the
// correct sign for every column (verified against a real file: e.g. "FBT
// fulfillment fee" is negative, its own "... reimbursement" column is
// positive, both literally named "Fulfillment fees" in the D365 mapping
// row and therefore indistinguishable by text) — so quantity here is driven
// by the amount's own sign, never by matching words in its label.
function buildSerLinesFromSignedAmounts(records) {
  const lines = [];
  const zeroSkipped = [];
  for (const rec of records) {
    const amount = toNumSafe(rec.amount);
    if (Math.abs(amount) < 0.005) {
      zeroSkipped.push(rec.feeType);
      continue;
    }
    const qty = amount < 0 ? -1 : 1;
    lines.push({
      "Item number": rec.itemCode, "Product name": rec.feeType, Warehouse: "", Location: "",
      "Unit price": Math.abs(amount), Discount: 0, Quantity: qty, "Net amount": amount,
    });
  }
  return { lines, zeroSkipped };
}

// ---------- Virtual bundle splitting (spec step 2) ----------

const VIRTUAL_BUNDLE_RE = /\(virtual bundle\)/i;

function isVirtualBundleName(name) {
  return VIRTUAL_BUNDLE_RE.test(String(name || ""));
}

// composition: [{ item, productName }]. allocation: optional array of the
// same length giving each component's share of net amount (must sum to 1);
// defaults to an even split, per spec ("unless the user specifies otherwise").
function splitVirtualBundle(row, composition, allocation) {
  const n = composition.length;
  if (!n) return [];
  const share = allocation && allocation.length === n ? allocation : composition.map(() => 1 / n);
  const qty = toNumSafe(row.qty);
  const netAmount = (toNumSafe(row.unitPrice) - toNumSafe(row.discount)) * qty;
  return composition.map((comp, i) => {
    const allocatedNet = netAmount * share[i];
    return {
      item: comp.item,
      productName: comp.productName || row.productName,
      warehouse: row.warehouse,
      location: row.location,
      unitPrice: qty ? allocatedNet / qty : 0,
      discount: 0,
      qty,
      netAmount: allocatedNet,
    };
  });
}

// ---------- FG item lines (spec step 2) ----------

// itemRecords: from extractRowRecords (fields sku/productName/unitPrice/
// discount/qty). bundleCompositions: {bundleSkuOrName: {composition, allocation}}
// keyed by the exact SKU/product-name text seen in the source row.
function buildFgLines(itemRecords, warehouse, location, bundleCompositions) {
  const lines = [];
  const unresolvedBundles = [];
  for (const rec of itemRecords) {
    const nameOrSku = rec.productName || rec.sku;
    if (isVirtualBundleName(rec.sku) || isVirtualBundleName(rec.productName)) {
      const key = bundleCompositions && rec.sku != null && bundleCompositions[rec.sku] ? rec.sku : nameOrSku;
      const bundle = bundleCompositions && bundleCompositions[key];
      if (!bundle || !bundle.composition || !bundle.composition.length) {
        unresolvedBundles.push({ row: rec.__row, name: nameOrSku });
        continue;
      }
      const split = splitVirtualBundle({ ...rec, warehouse, location }, bundle.composition, bundle.allocation);
      for (const s of split) {
        lines.push({
          "Item number": s.item,
          "Product name": s.productName || "",
          Warehouse: warehouse,
          Location: location,
          "Unit price": s.unitPrice,
          Discount: s.discount,
          Quantity: s.qty,
          "Net amount": s.netAmount,
          __sourceRow: rec.__row,
        });
      }
      continue;
    }
    const qty = toNumSafe(rec.qty);
    const unitPrice = toNumSafe(rec.unitPrice);
    const discount = toNumSafe(rec.discount);
    lines.push({
      "Item number": rec.sku,
      "Product name": rec.productName == null ? "" : String(rec.productName),
      Warehouse: warehouse,
      Location: location,
      "Unit price": unitPrice,
      Discount: discount,
      Quantity: qty,
      "Net amount": (unitPrice - discount) * qty,
      __sourceRow: rec.__row,
    });
  }
  return { lines, unresolvedBundles };
}

// ---------- Service/fee lines (spec step 3) ----------

// feeRecords: {feeType, itemCode, amount} rows (from either extractor).
// itemCodeOverrides: optional {feeType: itemCode} map for rows whose source
// table doesn't carry its own mapping (caller-supplied, e.g. from the user).
// isReimbursementFn(feeType) -> bool; defaults to matching "refund"/
// "reimbursement" in the fee type text (spec: refund is its own +1 line,
// distinct from any "administration fee" for it, which stays a normal -1 fee).
function buildFeeLines(feeRecords, itemCodeOverrides, isReimbursementFn) {
  const isReimb = isReimbursementFn || ((feeType) => /reimburs|^refund$/i.test(String(feeType || "").trim()));
  const lines = [];
  const zeroSkipped = [];
  const unresolvedItems = [];
  for (const rec of feeRecords) {
    const amount = toNumSafe(rec.amount);
    if (amount === 0) {
      zeroSkipped.push(rec.feeType);
      continue;
    }
    const itemCode = rec.itemCode || (itemCodeOverrides && itemCodeOverrides[rec.feeType]) || null;
    if (!itemCode) {
      unresolvedItems.push({ feeType: rec.feeType, amount });
      continue;
    }
    const reimbursement = isReimb(rec.feeType);
    const qty = reimbursement ? 1 : -1;
    const unitPrice = Math.abs(amount);
    lines.push({
      "Item number": itemCode,
      "Product name": rec.feeType,
      Warehouse: "",
      Location: "",
      "Unit price": unitPrice,
      Discount: 0,
      Quantity: qty,
      "Net amount": qty * unitPrice,
    });
  }
  return { lines, zeroSkipped, unresolvedItems };
}

// ---------- Final SO line table + reconciliation (spec steps 4-5) ----------

function buildSoLineTable(fgLines, feeLines) {
  return [...fgLines, ...feeLines].map((l) => ({
    "Item number": l["Item number"],
    "Product name": l["Product name"] || "",
    Warehouse: l.Warehouse || "",
    Location: l.Location || "",
    "Unit price": l["Unit price"],
    Discount: l.Discount || 0,
    Quantity: l.Quantity,
    "Net amount": l["Net amount"],
    ...TEMPLATE_FIELD_DEFAULTS,
  }));
}

function reconcile(rows, referenceTotal, tolerance) {
  const tol = tolerance == null ? 0.01 : tolerance;
  const sum = rows.reduce((s, r) => s + toNumSafe(r["Net amount"]), 0);
  const diff = Math.round((sum - referenceTotal) * 100) / 100;
  return { sum: Math.round(sum * 100) / 100, referenceTotal, diff, reconciled: Math.abs(diff) <= tol };
}

// Browser namespace — app.js calls these as taskE.xxx(...).
if (typeof window !== "undefined") {
  window.taskE = {
    REGION_DEFAULTS,
    TEMPLATE_FIELD_DEFAULTS,
    SO_LINE_COLUMNS,
    US_REFUND_ITEM_CODE,
    US_SER_NAME_SEED,
    colIndexFromLetter,
    colLetterFromIndex,
    extractRowRecords,
    extractTransposedFeeRecords,
    autoDetectUsSummaryTable,
    buildSerLinesFromSignedAmounts,
    isVirtualBundleName,
    splitVirtualBundle,
    buildFgLines,
    buildFeeLines,
    buildSoLineTable,
    reconcile,
  };
}

if (typeof module !== "undefined") {
  module.exports = {
    REGION_DEFAULTS,
    TEMPLATE_FIELD_DEFAULTS,
    SO_LINE_COLUMNS,
    US_REFUND_ITEM_CODE,
    US_SER_NAME_SEED,
    colIndexFromLetter,
    colLetterFromIndex,
    extractRowRecords,
    extractTransposedFeeRecords,
    autoDetectUsSummaryTable,
    buildSerLinesFromSignedAmounts,
    isVirtualBundleName,
    splitVirtualBundle,
    buildFgLines,
    buildFeeLines,
    buildSoLineTable,
    reconcile,
  };
}
