// Mirrors tests/test_task_b.py: real SO Status lines (refund/manual-fulfil
// scope) as ordered side, synthetic fulfillment data covering full ship,
// partial ship, not-fulfilled, bundle-SKU recovery, multi-tracking flag,
// service-line tracking inheritance, and Chinese status normalization.
const fs = require("fs");
const io = require("../js/io_utils");
const { computeFulfillmentCheck, buildJoinKey } = require("../js/task_b");

const BASE = "C:/Users/suki.chan_prenetics/Desktop/Claude/im8-open-SO-fulfillment-checking-tools";

const soPath = `${BASE}/samples/20260723 H007 Open SO (Jul22).xlsx`;
const soBytes = fs.readFileSync(soPath);
const soWb = io.loadWorkbook(soBytes, soPath);
const soRaw = io.sheetToRawRows(soWb, "SO Status", null);
const soRows = io.loadTableFromRawRows(soRaw, 3);

const scope = soRows.filter((r) =>
  ["Ops - refund order", "Ops - to manually fulfil and adjust inventory"].includes(r["Remarks"])
);

const openSo = scope.filter((r) =>
  ["H007-SO-032755", "H007-SO-209453", "H007-SO-212770", "H007-SO-214204", "H007-SO-203421"].includes(r["Sales order"])
);
console.log("open_so rows used:", openSo.length);

const soKeys = buildJoinKey(openSo, "Sales order");
const openSoWithKey = openSo.map((r, i) => ({
  ...r,
  key: soKeys[i],
  Warehouse: r["Warehouse"] == null ? "OPS-WH01" : r["Warehouse"],
}));

const fulfillmentRows = [
  { key: "H007-SO-032755", SKU: "IM8-FG-000040", "Bundle SKU": null, "Shipped qty": 1, "Tracking number": "TRACK-A1", "Shipped date": "2026-07-01", Status: "已出庫" },
  { key: "H007-SO-209453", SKU: "IM8-FG-000029", "Bundle SKU": null, "Shipped qty": 1, "Tracking number": "TRACK-B1", "Shipped date": "2026-07-02", Status: "已出庫" },
  { key: "H007-SO-209453", SKU: "IM8-FG-000143", "Bundle SKU": null, "Shipped qty": 1, "Tracking number": "TRACK-B1", "Shipped date": "2026-07-02", Status: "已出庫" },
  { key: "H007-SO-214204", SKU: "BUNDLE-XYZ-001", "Bundle SKU": "IM8-FG-000242", "Shipped qty": 1, "Tracking number": "TRACK-D1", "Shipped date": "2026-07-03", Status: "已出庫" },
  { key: "H007-SO-203421", SKU: "IM8-FG-000143", "Bundle SKU": null, "Shipped qty": 2, "Tracking number": "TRACK-E1", "Shipped date": "2026-07-04", Status: "已出庫" },
  { key: "H007-SO-203421", SKU: "IM8-FG-000242", "Bundle SKU": null, "Shipped qty": 1, "Tracking number": "TRACK-E2", "Shipped date": "2026-07-04", Status: "已出庫" },
];

const openSoCols = { key: "key", item: "Item number", warehouse: "Warehouse", ordered_qty: "Quantity" };
const fulfillmentCols = {
  key: "key", item: "SKU", bundle_item: "Bundle SKU", shipped_qty: "Shipped qty",
  tracking: "Tracking number", shipped_date: "Shipped date", status: "Status",
};

const { perSheet, diagnostics } = computeFulfillmentCheck(openSoWithKey, fulfillmentRows, openSoCols, fulfillmentCols);
console.log("\nDIAGNOSTICS:", JSON.stringify(diagnostics));
for (const [name, table] of Object.entries(perSheet)) {
  console.log("=".repeat(60));
  console.log(name);
  console.table(table);
}

const allRows = Object.values(perSheet).flat();
function findRows(soNumber) {
  return allRows.filter((r) => r["Sales order number"] === soNumber);
}

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}

const so032755 = findRows("H007-SO-032755");
const fg032755 = so032755.filter((r) => r.SKU !== "IM8-SER-000003");
assert(
  fg032755.reduce((s, r) => s + r["Shipped qty"], 0) === fg032755.reduce((s, r) => s + r["Ordered qty"], 0),
  "032755 FG lines should be fully shipped"
);
const serviceRow = so032755.find((r) => r.SKU === "IM8-SER-000003");
assert(serviceRow["Tracking number"] === "TRACK-A1", "service line should inherit tracking from FG line");
assert(serviceRow["Shipped date"] === "2026-07-01", "service line should inherit shipped date");

const so209453 = findRows("H007-SO-209453");
assert(so209453.reduce((s, r) => s + r["Outstanding qty"], 0) > 0, "209453 should have outstanding qty (partial)");

const so212770 = findRows("H007-SO-212770");
assert(so212770.every((r) => r["Shipped qty"] === 0), "212770 should be fully unshipped");

const so214204 = findRows("H007-SO-214204");
const bundleLine = so214204.find((r) => r.SKU === "IM8-FG-000242");
assert(bundleLine["Shipped qty"] === 1, "214204 should recover shipped qty via bundle SKU");
assert(bundleLine["Tracking number"] === "TRACK-D1", "214204 tracking should be TRACK-D1");

const so203421 = findRows("H007-SO-203421");
assert(
  so203421.some((r) => r.Flag && r.Flag.includes("Multiple tracking numbers")),
  "203421 should be flagged for multiple tracking numbers"
);

assert(diagnostics.bundle_sku_recovered >= 1, "expected bundle_sku_recovered >= 1");
assert(diagnostics.multi_tracking_orders >= 1, "expected multi_tracking_orders >= 1");

const sheetNames = Object.keys(perSheet);
assert(sheetNames.some((n) => n.includes("(Shipped)")), "expected a Shipped sheet");
assert(sheetNames.some((n) => n.includes("(Partially Shipped)")), "expected a Partially Shipped sheet");
assert(sheetNames.some((n) => n.includes("(Not Fulfilled)")), "expected a Not Fulfilled sheet");

if (!ok) {
  console.error("\nTASK B JS TEST FAILED");
  process.exit(1);
}
console.log("\nALL TASK B JS ASSERTIONS PASSED");
