// Normalize known Chinese WMS status strings to English. Port of lib/status_i18n.py.
// Only the term confirmed in the spec is mapped by default — extend as more
// real values are observed. Unknown values pass through unchanged.

const STATUS_TRANSLATIONS = {
  "已出庫": "Dispatched",
  "已出库": "Dispatched",
};

function normalizeStatus(value) {
  if (value == null) return value;
  const s = String(value).trim();
  return STATUS_TRANSLATIONS[s] || s;
}

if (typeof module !== "undefined") {
  module.exports = { STATUS_TRANSLATIONS, normalizeStatus };
}
