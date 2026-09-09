// Synthetic-fixture tests for Task E (TikTok -> D365 SO lines), since no
// real TikTok transactions export exists yet in samples/. Mirrors the exact
// rules in TikTok_to_D365_SO_Workflow.md: virtual-bundle splitting, fee sign
// convention, $0-fee skipping, refund-as-its-own-line, and mandatory
// reconciliation against a reference total.
const taskE = require("../js/task_e");

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}

// ---- Column-letter helpers ----
assert(taskE.colIndexFromLetter("A") === 0, "A -> 0");
assert(taskE.colIndexFromLetter("K") === 10, "K -> 10");
assert(taskE.colIndexFromLetter("Q") === 16, "Q -> 16");
assert(taskE.colIndexFromLetter("AA") === 26, "AA -> 26");
assert(taskE.colLetterFromIndex(10) === "K", "10 -> K");
assert(taskE.colLetterFromIndex(26) === "AA", "26 -> AA");

// ---- extractRowRecords: build a synthetic sales table at cols K:O, rows 2-4 ----
const rawRows = [];
rawRows[0] = []; // row 1: header (ignored, range starts at row 2)
rawRows[1] = []; rawRows[1][10] = "SKU-A"; rawRows[1][11] = "Product A"; rawRows[1][12] = 10; rawRows[1][13] = 1; rawRows[1][14] = 2;
rawRows[2] = []; rawRows[2][10] = "SKU-B (virtual bundle)"; rawRows[2][11] = "Bundle B"; rawRows[2][12] = 20; rawRows[2][13] = 0; rawRows[2][14] = 3;
rawRows[3] = []; // fully blank row 4 -> end of table
const { records, skippedBlankRows } = taskE.extractRowRecords(
  rawRows, { startRow: 2, endRow: 5 },
  { sku: "K", productName: "L", unitPrice: "M", discount: "N", qty: "O" }
);
assert(records.length === 2, `expected 2 records, got ${records.length}`);
assert(records[0].sku === "SKU-A" && records[0].qty === 2, "row 1 fields");
assert(skippedBlankRows.includes(4), "blank row 4 should be recorded as skipped, not silently merged");

// ---- buildFgLines: plain item + virtual bundle split ----
const bundleCompositions = {
  "Bundle B": { composition: [{ item: "IM8-COMP-1", productName: "Component 1" }, { item: "IM8-COMP-2", productName: "Component 2" }] },
};
const { lines: fgLines, unresolvedBundles } = taskE.buildFgLines(records, "USOPS-WH07", "Primary", bundleCompositions);
assert(unresolvedBundles.length === 0, "bundle should resolve via the provided composition");
assert(fgLines.length === 3, `expected 3 FG lines (1 plain + 2 bundle components), got ${fgLines.length}`); // SKU-A + 2 components of Bundle B
const plainLine = fgLines.find((l) => l["Item number"] === "SKU-A");
assert(plainLine["Net amount"] === (10 - 1) * 2, `expected Net amount 18, got ${plainLine["Net amount"]}`);
const comp1 = fgLines.find((l) => l["Item number"] === "IM8-COMP-1");
const comp2 = fgLines.find((l) => l["Item number"] === "IM8-COMP-2");
const bundleNet = 20 * 3; // (20 - 0) * 3
assert(comp1["Net amount"] === bundleNet / 2, `expected even split ${bundleNet / 2}, got ${comp1["Net amount"]}`);
assert(comp1.Quantity === 3 && comp2.Quantity === 3, "each bundle component keeps the bundle row's quantity");
assert(comp1["Net amount"] + comp2["Net amount"] === bundleNet, "component net amounts must sum back to the bundle row's net amount");

// ---- Unresolved bundle (no composition provided) must be flagged, not silently dropped or guessed ----
const { unresolvedBundles: unresolved2 } = taskE.buildFgLines(records, "USOPS-WH07", "Primary", {});
assert(unresolved2.length === 1 && unresolved2[0].name === "Bundle B", "missing bundle composition should be flagged for the user");

// ---- Bundle names that ARE real item codes joined by "&" auto-parse — no manual composition needed ----
assert(
  JSON.stringify(taskE.tryParseBundleNameComponents("IM8-FG-000127 & IM8-FG-000198 (virtual bundle)")) ===
    JSON.stringify([{ item: "IM8-FG-000127", productName: "" }, { item: "IM8-FG-000198", productName: "" }]),
  "a bundle name that's just real SKUs joined by & should parse into those components directly"
);
assert(
  taskE.tryParseBundleNameComponents("IM8-FG-000127 & IM8-FG-000198 & IM8-FG-000200 (virtual bundle)").length === 3,
  "should handle more than 2 components"
);
assert(
  taskE.tryParseBundleNameComponents("Starter Kit & Travel Pack (virtual bundle)") === null,
  "a friendly/marketing name (not real SKU codes) must NOT be guessed at — still needs manual entry"
);
assert(taskE.tryParseBundleNameComponents("Bundle B") === null, "a name with no components at all should not parse");

const skuBundleRecords = [
  { __row: 1, sku: "IM8-FG-000127 & IM8-FG-000198 (virtual bundle)", productName: null, unitPrice: 35, discount: 0, qty: 10 },
];
const { lines: skuBundleLines, unresolvedBundles: skuBundleUnresolved } = taskE.buildFgLines(skuBundleRecords, "USOPS-WH07", "Primary", {});
assert(skuBundleUnresolved.length === 0, "a SKU-named bundle must auto-resolve even with NO composition supplied at all");
assert(skuBundleLines.length === 2, `expected 2 lines (one per component), got ${skuBundleLines.length}`);
assert(skuBundleLines.every((l) => l.Quantity === 10), "each component must carry the FULL quantity, not a split share");
assert(skuBundleLines.find((l) => l["Item number"] === "IM8-FG-000127") && skuBundleLines.find((l) => l["Item number"] === "IM8-FG-000198"), "both real component SKUs must appear as their own lines");

// ---- buildFeeLines: sign convention, $0 skip, refund as its own line ----
const feeRecords = [
  { feeType: "FBT fulfillment fee", itemCode: "IM8-SER-000023", amount: 45.5 },
  { feeType: "Fee for FBT free shipping", itemCode: "IM8-SER-000023", amount: 12.0 },
  { feeType: "Refund administration fee", itemCode: "IM8-SER-000030", amount: 0 }, // $0 -> skipped
  { feeType: "Refund", itemCode: "IM8-SER-000005", amount: 30.0 }, // reimbursement -> +1
];
const { lines: feeLines, zeroSkipped, unresolvedItems } = taskE.buildFeeLines(feeRecords);
assert(zeroSkipped.length === 1 && zeroSkipped[0] === "Refund administration fee", "the $0 fee row must be skipped");
assert(unresolvedItems.length === 0, "all fee rows here have an item code and should resolve");
assert(feeLines.length === 3, `expected 3 fee lines (2 fees + 1 refund), got ${feeLines.length}`);
const fbtLine = feeLines.find((l) => l["Product name"] === "FBT fulfillment fee");
assert(fbtLine.Quantity === -1, "fees must carry Quantity -1 (cost to company)");
assert(fbtLine["Net amount"] === -45.5, `expected Net amount -45.5, got ${fbtLine["Net amount"]}`);
const refundLine = feeLines.find((l) => l["Product name"] === "Refund");
assert(refundLine.Quantity === 1, "reimbursements/refunds must carry Quantity +1");
assert(refundLine["Net amount"] === 30.0, `expected Net amount 30, got ${refundLine["Net amount"]}`);

// A fee row with no item code (and no override) must be flagged, not dropped silently.
const { unresolvedItems: unresolved3 } = taskE.buildFeeLines([{ feeType: "Mystery fee", itemCode: null, amount: 5 }]);
assert(unresolved3.length === 1 && unresolved3[0].feeType === "Mystery fee", "a fee row with no resolvable item code must be flagged");

// ---- buildSoLineTable + reconcile ----
const table = taskE.buildSoLineTable(fgLines, feeLines);
assert(table.every((r) => r["Delivery type"] === "Stock" && r.Site === "Prenetics" && r.Currency === "USD"), "every line must carry the fixed template field defaults");
assert(table.every((r) => r["Line status"] === "Invoiced" && r["Fulfillment status"] === "Unknown"), "template defaults for status fields");

const referenceTotal = table.reduce((s, r) => s + r["Net amount"], 0);
const good = taskE.reconcile(table, referenceTotal);
assert(good.reconciled === true, "sum of the table's own Net amounts must reconcile against itself exactly");

const bad = taskE.reconcile(table, referenceTotal + 5);
assert(bad.reconciled === false && Math.abs(bad.diff - -5) < 1e-9, `expected a -5 diff when reference is off by 5, got ${bad.diff}`);

// ---- US-style transposed fee table ----
const transposedRaw = [];
transposedRaw[10] = []; // row 11 (1-based) = fee type names
transposedRaw[10][3] = "FBT fulfillment fee"; transposedRaw[10][4] = "Refund";
transposedRaw[11] = []; // row 12 = item codes
transposedRaw[11][3] = "IM8-SER-000023"; transposedRaw[11][4] = "IM8-SER-000005";
transposedRaw[12] = []; // row 13 = dollar amounts
transposedRaw[12][3] = 100; transposedRaw[12][4] = 25;
const transposedRecords = taskE.extractTransposedFeeRecords(transposedRaw, { startCol: "D", endCol: "E", feeTypeRow: 11, itemCodeRow: 12, amountRow: 13 });
assert(transposedRecords.length === 2, `expected 2 transposed fee records, got ${transposedRecords.length}`);
assert(transposedRecords[0].feeType === "FBT fulfillment fee" && transposedRecords[0].itemCode === "IM8-SER-000023" && transposedRecords[0].amount === 100, "transposed record 1 fields");
assert(transposedRecords[1].feeType === "Refund" && transposedRecords[1].amount === 25, "transposed record 2 fields");

if (!ok) {
  console.error("\nTASK E TEST FAILED");
  process.exit(1);
}
console.log("TASK E TEST PASSED");
