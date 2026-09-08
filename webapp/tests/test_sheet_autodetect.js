// Regression test for two real bugs, both the same root cause: uploading the
// FULL multi-tab Open SO workbook (as opposed to a purpose-built single-sheet
// extract) into Task A's "Requested inventory file" slot made pickBestSheet
// auto-select the wrong sheet.
//
// 1. H007 file: picked "List of Fulfilled Orders" (historical, already-
//    shipped orders) instead of "SO Status" (the real current open-order
//    data, validated against the ops team's own pivot in test_task_a.js) —
//    both score similarly on raw header-keyword overlap.
// 2. U001 file: the SAME ops team renamed the real sheet from "SO Status" to
//    plain "SO" in a later export, which defeated a name-keyword-only fix —
//    "Sheet1" (a 113-row scratch tab) then won purely on coincidental header
//    overlap. The real sheet ("SO", 27809 rows) is always dramatically larger
//    than any scratch/summary tab regardless of what it's named, so sheet
//    size must factor into the score, not just header keywords + name hints.
const io = require("../js/io_utils");
const fs = require("fs");

const BASE = "C:/Users/suki.chan_prenetics/Desktop/Claude/im8-open-SO-fulfillment-checking-tools";

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}

const TASK_A_REQUESTED_CANDIDATES = {
  item: ["item number", "sku", "item no", "item"],
  warehouse: ["warehouse", "site"],
  qty: ["requested qty", "requested quantity", "quantity", "qty", "ordered qty"],
  remarks: ["remarks"],
};
const TASK_B_OPEN_SO_CANDIDATES = {
  so_number: ["sales order", "sales order number", "so number"],
  shopify_ref: ["shopify reference", "shopify ref", "reference"],
  item: ["item number", "sku", "item"],
  warehouse: ["warehouse", "site"],
  qty: ["ordered qty", "quantity", "qty"],
  remarks: ["remarks"],
};

const h007Bytes = fs.readFileSync(`${BASE}/samples/20260723 H007 Open SO (Jul22).xlsx`);
const h007Wb = io.loadWorkbook(h007Bytes, "x.xlsx");

const aPick = io.pickBestSheet(h007Wb, TASK_A_REQUESTED_CANDIDATES, 20);
console.log("H007 Task A auto-pick:", JSON.stringify(aPick));
assert(aPick.sheet === "SO Status", `Task A should auto-pick 'SO Status', got '${aPick.sheet}'`);
assert(aPick.row === 3, `expected header row 3, got ${aPick.row}`);

const bPick = io.pickBestSheet(h007Wb, TASK_B_OPEN_SO_CANDIDATES, 20);
console.log("H007 Task B auto-pick:", JSON.stringify(bPick));
assert(bPick.sheet === "SO Status", `Task B should auto-pick 'SO Status', got '${bPick.sheet}'`);

const u001Bytes = fs.readFileSync(`${BASE}/samples/20260730 U001 Open SO (Jul30).xlsx`);
const u001Wb = io.loadWorkbook(u001Bytes, "x.xlsx");

const aPickU001 = io.pickBestSheet(u001Wb, TASK_A_REQUESTED_CANDIDATES, 20);
console.log("U001 Task A auto-pick:", JSON.stringify(aPickU001));
assert(aPickU001.sheet === "SO", `Task A should auto-pick 'SO', got '${aPickU001.sheet}'`);
assert(aPickU001.row === 2, `expected header row 2, got ${aPickU001.row}`);

const bPickU001 = io.pickBestSheet(u001Wb, TASK_B_OPEN_SO_CANDIDATES, 20);
console.log("U001 Task B auto-pick:", JSON.stringify(bPickU001));
assert(bPickU001.sheet === "SO", `Task B should auto-pick 'SO', got '${bPickU001.sheet}'`);

if (!ok) {
  console.error("\nSHEET AUTODETECT TEST FAILED");
  process.exit(1);
}
console.log("\nSHEET AUTODETECT TEST PASSED");
