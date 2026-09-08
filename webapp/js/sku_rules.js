// Cross-cutting SKU rules shared by Task A and Task B. Port of lib/sku_rules.py.

const SKU_ALIAS_MAP = {
  "IM8-FAKE-216": "IM8-FG-000216",
  "IM8-FAKE-215": "IM8-FG-000215",
};

const SERVICE_SKU_PREFIX = "IM8-SER-";
const PALLET_SKU_MARKERS = ["9X7X4", "10X8X5"];

function normalizeSku(sku) {
  if (sku == null) return sku;
  const s = String(sku).trim();
  return SKU_ALIAS_MAP[s] || s;
}

function isServiceSku(sku) {
  return String(sku == null ? "" : sku).trim().toUpperCase().startsWith(SERVICE_SKU_PREFIX);
}

function isPalletSku(sku) {
  const s = String(sku == null ? "" : sku).trim().toUpperCase();
  return PALLET_SKU_MARKERS.some((marker) => s.includes(marker));
}

function isExcludedSku(sku) {
  return isServiceSku(sku) || isPalletSku(sku);
}

if (typeof module !== "undefined") {
  module.exports = { SKU_ALIAS_MAP, normalizeSku, isServiceSku, isPalletSku, isExcludedSku };
}
