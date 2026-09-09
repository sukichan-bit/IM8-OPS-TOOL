// Task F — Amazon Transactions -> D365 Sales Order Lines.
// Process reference: Amazon_Template_Process.md (upgraded to target the
// D365 SO Line import layout — see Amazon_SO_Line_Template.xlsx). Unlike
// TikTok (Task E), Amazon's Summary/SKU+Refund layout is documented as
// stable month to month, so this locates the key rows/columns by label
// text (not fixed row numbers) but does not need a per-run configuration
// panel the way Task E does.

function toNumSafe(v) {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/[,$]/g, ""));
  return isNaN(n) ? 0 : n;
}

const AMAZON_DUTY_TAX_SKU = "IM8-SER-000004";
const AMAZON_REFUND_SKU = "IM8-SER-000005";

const AMAZON_SO_TEMPLATE_COLUMNS = [
  "Variant number", "Bundle sales item", "Bundle Retail VariantId", "Item number", "Product name",
  "Sales category", "Quantity", "Unit", "Style", "Delivery type", "Adjusted unit price", "Site",
  "Warehouse", "Batch number", "Location", "Unit price", "Discount", "Discount percent", "Net amount",
  "Currency", "Line status", "Adjusted net amount", "Quality order status", "Deliver now", "Line type",
  "Source code", "Load", "Packing quantity", "Created date and time", "Same batch selection",
  "Fulfillment status", "DOM Status", "Promotion Code", "Refund transaction ID", "Disposition code",
  "Return reason code", "Total discount amount", "Discount type", "Modified by",
];

// FG item master (Item number -> {name, unit}), keyed separately from Task
// A's item master since Amazon needs the D365 unit of measure too, not just
// the product name. Seeded with the items seen so far so a new month with
// the same SKUs needs no manual entry; a genuinely new FG SKU shows up as a
// flagged row rather than a guess.
const AMAZON_ITEM_MASTER_SEED = {
  "IM8-FG-000120": { name: "Daily Essentials 30 Servings,Gusset bag with scoop, NSF,v1.5", unit: "Pouch" },
  "IM8-FG-000053": { name: "Daily Essentials - Travel Sachet (30 Pack), Non-NSF", unit: "Box" },
  "IM8-FG-000076": { name: "Essential Starter Kit - One Time Purchase", unit: "Set" },
  "IM8-FG-000080": { name: "Essential Starter Kit (Travel 30) - One Time Purchase", unit: "Set" },
  "IM8-FG-000196": { name: "Essentials - Travel Box Set (30ct), Variety - STD", unit: "Box" },
  "IM8-FG-000187": { name: "Essentials - Travel Box Set (30ct), Orange Lemon - STD", unit: "Box" },
  "IM8-FG-000200": { name: "Essentials - Travel Box Set (30ct), Acai - STD", unit: "Box" },
  "IM8-FG-000188": { name: "Essentials - Travel Box Set (30ct), Mango Passionfruit - STD", unit: "Box" },
  "IM8-FG-000233": { name: "Refill - Quarterly Subscription - Essentials V2 - Variety", unit: "Set" },
  "IM8-FG-000230": { name: "Refill - Quarterly Subscription - Essentials V2 - Lemon", unit: "Set" },
};
// SER item master (Item number -> D365's own product name spelling), kept
// separate because D365 sometimes spells these differently to the Summary
// tab's own column headers (e.g. "Fulfilment fees", one L).
const AMAZON_SER_NAME_SEED = {
  "IM8-SER-000003": "Shipping Charges",
  "IM8-SER-000015": "Advertising Expenses",
  "IM8-SER-000013": "Commission expense",
  "IM8-SER-000023": "Fulfilment fees",
  "IM8-SER-000002": "Payment Gateway Fees",
  "IM8-SER-000005": "Refund",
};

// ---------- Summary tab extraction (label-anchored, not fixed row numbers) ----------

function amazonFindRowByLabel(rawRows, label) {
  const re = new RegExp("^" + label.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$", "i");
  for (let r = 0; r < rawRows.length; r++) {
    const cell = rawRows[r] && rawRows[r][0];
    if (cell != null && re.test(String(cell))) return r;
  }
  return -1;
}

function amazonFindSerSkuRow(rawRows, startRow) {
  const end = Math.min(startRow + 15, rawRows.length);
  for (let r = startRow; r < end; r++) {
    const row = rawRows[r] || [];
    const hits = row.filter((v) => v != null && /^IM8-SER-\d+$/i.test(String(v).trim()));
    if (hits.length >= 2) return r;
  }
  return -1;
}

function amazonFindNetSales(rawRows) {
  for (let r = 0; r < rawRows.length; r++) {
    const row = rawRows[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (row[c] != null && /net sales/i.test(String(row[c]).trim())) {
        for (let c2 = c + 1; c2 < row.length; c2++) {
          if (typeof row[c2] === "number") return { row: r, col: c, value: row[c2] };
        }
      }
    }
  }
  return null;
}

// Returns { serLines: [{sku,name,qty,unitPrice,netAmount}], netSales, diagnostics }.
// serNames overrides the D365-spelling lookup (defaults to AMAZON_SER_NAME_SEED).
function extractAmazonSummary(rawRows, serNames) {
  const names = serNames || AMAZON_SER_NAME_SEED;
  const orderRow = amazonFindRowByLabel(rawRows, "Order");
  const refundRow = amazonFindRowByLabel(rawRows, "Refund");
  const transferRow = amazonFindRowByLabel(rawRows, "Transfer");
  const grandTotalRow = amazonFindRowByLabel(rawRows, "Grand Total");
  const missing = [];
  if (orderRow < 0) missing.push("Order");
  if (refundRow < 0) missing.push("Refund");
  if (transferRow < 0) missing.push("Transfer");
  if (grandTotalRow < 0) missing.push("Grand Total");
  if (missing.length) {
    throw new Error(`Could not find row(s) labelled ${missing.join(", ")} in column A of the Summary tab — layout may have changed.`);
  }
  const serSkuRow = amazonFindSerSkuRow(rawRows, grandTotalRow);
  if (serSkuRow < 0) throw new Error("Could not find the SER item-number row (e.g. IM8-SER-000003) below Grand Total in the Summary tab.");
  const serNameRow = serSkuRow + 1;
  const netSalesInfo = amazonFindNetSales(rawRows);
  if (!netSalesInfo) throw new Error('Could not find a "Net sales" figure in the Summary tab.');

  const grand = rawRows[grandTotalRow] || [];
  const transfer = rawRows[transferRow] || [];
  const refund = rawRows[refundRow] || [];
  const skuRow = rawRows[serSkuRow] || [];
  const nameRow = rawRows[serNameRow] || [];

  const serLines = [];
  // Columns C..L (0-based idx 2..11): direct Grand Total value per column.
  for (let c = 2; c <= 11; c++) {
    const skuRaw = skuRow[c];
    if (skuRaw == null || String(skuRaw).trim() === "") continue;
    const sku = String(skuRaw).trim();
    if (sku === AMAZON_DUTY_TAX_SKU) continue;
    const value = toNumSafe(grand[c]);
    if (Math.abs(value) < 0.005) continue;
    serLines.push({
      sku,
      name: names[sku] || (nameRow[c] == null ? sku : String(nameRow[c]).trim()),
      qty: value < 0 ? -1 : 1,
      unitPrice: Math.abs(value),
      netAmount: value,
    });
  }
  // Column M (0-based idx 12, "Sum of other") — special case: Grand Total
  // minus Transfer isolates the non-payout portion. Reversing the sign
  // leaves a gap of exactly 2x the value at reconciliation time.
  const mSkuRaw = skuRow[12];
  if (mSkuRaw != null && String(mSkuRaw).trim() !== "") {
    const mSku = String(mSkuRaw).trim();
    if (mSku !== AMAZON_DUTY_TAX_SKU) {
      const mValue = toNumSafe(grand[12]) - toNumSafe(transfer[12]);
      if (Math.abs(mValue) >= 0.005) {
        serLines.push({
          sku: mSku,
          name: names[mSku] || (nameRow[12] == null ? mSku : String(nameRow[12]).trim()),
          qty: mValue < 0 ? -1 : 1,
          unitPrice: Math.abs(mValue),
          netAmount: mValue,
        });
      }
    }
  }
  // Refund SER line — one line only (refund detail rows are never added
  // separately; the Order block's "Sum of product sales" Grand Total
  // already includes refunded amounts, so adding both double-counts).
  const refundValue = toNumSafe(refund[1]);
  serLines.push({
    sku: AMAZON_REFUND_SKU,
    name: names[AMAZON_REFUND_SKU] || "Refund",
    qty: refundValue < 0 ? -1 : 1,
    unitPrice: Math.abs(refundValue),
    netAmount: refundValue,
  });

  return {
    serLines,
    netSales: netSalesInfo.value,
    diagnostics: { orderRow, refundRow, transferRow, grandTotalRow, serSkuRow, serNameRow },
  };
}

// ---------- SKU + Refund tab extraction (Order block only; refund detail rows are never used) ----------

function extractAmazonOrderLines(rawRows) {
  let headerRow = -1;
  for (let r = 0; r < rawRows.length; r++) {
    const v = rawRows[r] && rawRows[r][0];
    if (v != null && String(v).trim().toLowerCase() === "sku") { headerRow = r; break; }
  }
  if (headerRow < 0) {
    throw new Error('Could not find the "sku" header in column A of the SKU + Refund tab (Order block).');
  }
  const records = [];
  let currentSku = null;
  for (let r = headerRow + 1; r < rawRows.length; r++) {
    const row = rawRows[r] || [];
    let skuCell = row[0];
    const unitCost = row[1];
    const qty = row[2];
    const sales = row[3];
    if (skuCell != null && String(skuCell).trim() !== "") {
      const skuStr = String(skuCell).trim();
      if (skuStr.toLowerCase() === "grand total") break; // end of Order block
      if (/ total$/i.test(skuStr)) continue; // per-SKU subtotal row
      currentSku = skuStr;
    } else if (currentSku == null) {
      continue;
    }
    if (qty == null || sales == null) continue;
    records.push({ sku: currentSku, unitCost: toNumSafe(unitCost), qty: toNumSafe(qty), netAmount: toNumSafe(sales) });
  }
  return records;
}

// ---------- SKU remap (spec §4) ----------

const AMAZON_SKU_REMAP = {
  "IM8-FG-000035-SCOOP": "IM8-FG-000120",
  "HM-53-0100": "IM8-FG-000076",
  "HM-53-0104": "IM8-FG-000080",
  "HM-53-0059": "IM8-FG-000053",
};

function amazonRemapSku(sku) {
  return AMAZON_SKU_REMAP[sku] || sku;
}

// ---------- Build the full SO line table ----------

function buildAmazonFgLines(orderRecords, itemMaster) {
  const lines = [];
  const unmapped = [];
  for (const rec of orderRecords) {
    const mapped = amazonRemapSku(rec.sku);
    const master = itemMaster[mapped];
    if (!master) {
      unmapped.push(mapped);
      lines.push({
        "Item number": mapped, "Product name": "", Unit: "",
        Quantity: rec.qty, "Unit price": rec.unitCost, "Net amount": rec.netAmount,
      });
      continue;
    }
    lines.push({
      "Item number": mapped, "Product name": master.name, Unit: master.unit,
      Quantity: rec.qty, "Unit price": rec.unitCost, "Net amount": rec.netAmount,
    });
  }
  return { lines, unmapped: Array.from(new Set(unmapped)) };
}

function buildAmazonSerLines(serLines) {
  return serLines.map((l) => ({
    "Item number": l.sku, "Product name": l.name, Unit: "ea",
    Quantity: l.qty, "Unit price": l.unitPrice, "Net amount": l.netAmount,
  }));
}

const AMAZON_TEMPLATE_FIELD_DEFAULTS_FG = {
  "Variant number": null, "Bundle sales item": null, "Bundle Retail VariantId": null,
  "Sales category": null, Style: null, "Delivery type": "Stock", "Adjusted unit price": 0,
  Site: "Prenetics", Warehouse: "USOPS-WH02", "Batch number": null, Location: "Primary",
  Discount: 0, "Discount percent": 0, Currency: "USD", "Line status": "Open order",
  "Adjusted net amount": 0, "Quality order status": null, "Deliver now": 0, "Line type": "Regular",
  "Source code": null, Load: null, "Packing quantity": 0, "Same batch selection": "No",
  "Fulfillment status": "Unknown", "DOM Status": "Not processed", "Promotion Code": null,
  "Refund transaction ID": null, "Disposition code": null, "Return reason code": null,
  "Total discount amount": 0, "Discount type": null, "Modified by": "suki.chan",
};
const AMAZON_TEMPLATE_FIELD_DEFAULTS_SER = {
  ...AMAZON_TEMPLATE_FIELD_DEFAULTS_FG,
  Warehouse: null,
  Location: null,
};

function buildAmazonSoLineTable(fgLines, serLines) {
  const now = new Date();
  const rows = [];
  for (const l of fgLines) {
    rows.push({
      ...AMAZON_TEMPLATE_FIELD_DEFAULTS_FG,
      "Item number": l["Item number"], "Product name": l["Product name"], Unit: l.Unit,
      Quantity: l.Quantity, "Unit price": l["Unit price"], "Net amount": l["Net amount"],
      "Created date and time": now,
    });
  }
  for (const l of serLines) {
    rows.push({
      ...AMAZON_TEMPLATE_FIELD_DEFAULTS_SER,
      "Item number": l["Item number"], "Product name": l["Product name"], Unit: l.Unit,
      Quantity: l.Quantity, "Unit price": l["Unit price"], "Net amount": l["Net amount"],
      "Created date and time": now,
    });
  }
  return rows.map((r) => {
    const ordered = {};
    for (const col of AMAZON_SO_TEMPLATE_COLUMNS) ordered[col] = r[col] === undefined ? null : r[col];
    return ordered;
  });
}

function amazonReconcile(rows, netSales, tolerance) {
  const tol = tolerance == null ? 0.01 : tolerance;
  const sum = rows.reduce((s, r) => s + toNumSafe(r["Net amount"]), 0);
  const diff = Math.round((sum - netSales) * 100) / 100;
  return { sum: Math.round(sum * 100) / 100, netSales, diff, reconciled: Math.abs(diff) <= tol };
}

// Browser namespace — app.js calls these as taskF.xxx(...).
if (typeof window !== "undefined") {
  window.taskF = {
    AMAZON_DUTY_TAX_SKU,
    AMAZON_REFUND_SKU,
    AMAZON_SO_TEMPLATE_COLUMNS,
    AMAZON_ITEM_MASTER_SEED,
    AMAZON_SER_NAME_SEED,
    AMAZON_SKU_REMAP,
    toNumSafe,
    amazonFindRowByLabel,
    amazonFindSerSkuRow,
    amazonFindNetSales,
    extractAmazonSummary,
    extractAmazonOrderLines,
    amazonRemapSku,
    buildAmazonFgLines,
    buildAmazonSerLines,
    buildAmazonSoLineTable,
    amazonReconcile,
  };
}

if (typeof module !== "undefined") {
  module.exports = {
    AMAZON_DUTY_TAX_SKU,
    AMAZON_REFUND_SKU,
    AMAZON_SO_TEMPLATE_COLUMNS,
    AMAZON_ITEM_MASTER_SEED,
    AMAZON_SER_NAME_SEED,
    AMAZON_SKU_REMAP,
    toNumSafe,
    amazonFindRowByLabel,
    amazonFindSerSkuRow,
    amazonFindNetSales,
    extractAmazonSummary,
    extractAmazonOrderLines,
    amazonRemapSku,
    buildAmazonFgLines,
    buildAmazonSerLines,
    buildAmazonSoLineTable,
    amazonReconcile,
  };
}
