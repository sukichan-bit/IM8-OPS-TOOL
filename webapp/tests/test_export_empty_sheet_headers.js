// Regression test for a real user-reported D365 import failure: Task C's
// Step 5/7 "serial number" sheet is meant to stay empty (no serialized
// items), but the old code built it via `[{...}].slice(0, 0)` — which
// produces a genuinely empty array with NO trace of the intended column
// names — combined with toExcelBytes's `if (!rows.length) continue`, which
// skipped writing a header row entirely for any empty sheet. The result was
// a worksheet with literally nothing on it, not even headers, which D365
// rejected on upload. Fix: toExcelBytes now accepts an explicit
// {columns, rows} form so a deliberately-empty sheet still gets its real
// header row.
const io = require("../js/io_utils");

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    ok = false;
  }
}

(async () => {
  // ---- The exact real-world shape: a populated "order" sheet + an
  // intentionally-empty "serial number" sheet that must still carry headers.
  const buf = await io.toExcelBytes({
    order: [{ "Order ID": "H007-SO-1", "SKU Number": "IM8-FG-000001" }],
    "serial number": { columns: ["Order ID", "SKU Number", "Serial number"], rows: [] },
  });
  const wb = io.loadWorkbook(buf, "check.xlsx");
  assert(wb.SheetNames.includes("serial number"), "expected a 'serial number' sheet to exist");
  const raw = io.sheetToRawRows(wb, "serial number", null);
  assert(raw.length >= 1, `expected at least a header row in the empty sheet, got ${raw.length} raw rows`);
  assert(JSON.stringify(raw[0]) === JSON.stringify(["Order ID", "SKU Number", "Serial number"]), `expected the real headers, got ${JSON.stringify(raw[0])}`);
  assert(raw.length === 1, "expected exactly the header row and no data rows");

  // ---- Old broken idiom, kept here only to document the exact prior bug (must NOT be used going forward, but toExcelBytes should degrade gracefully: no explicit columns + no rows = no header, which is the pre-existing behavior for genuinely-unknown-shape empty sheets). ----
  const oldBuf = await io.toExcelBytes({
    order: [{ "Order ID": "H007-SO-1" }],
    "serial number": [{ "Order ID": null, "SKU Number": null, "Serial number": null }].slice(0, 0),
  });
  const oldWb = io.loadWorkbook(oldBuf, "check2.xlsx");
  const oldRaw = io.sheetToRawRows(oldWb, "serial number", null);
  // A worksheet with no rows added at all reads back as a single blank cell,
  // not real headers — this is exactly what the real failing file had.
  assert(!(oldRaw.length >= 1 && JSON.stringify(oldRaw[0]) === JSON.stringify(["Order ID", "SKU Number", "Serial number"])), "sanity check on the old idiom: without explicit columns, an empty array truly can't produce real headers (confirms why the fix was necessary)");

  // ---- Backward compatibility: normal populated sheets (plain array) still work exactly as before. ----
  const normalBuf = await io.toExcelBytes({ order: [{ "Order ID": "SO-1", Qty: 3 }, { "Order ID": "SO-2", Qty: 5 }] });
  const normalWb = io.loadWorkbook(normalBuf, "check3.xlsx");
  const normalRaw = io.sheetToRawRows(normalWb, "order", null);
  assert(normalRaw.length === 3, `expected header + 2 data rows, got ${normalRaw.length}`);
  assert(JSON.stringify(normalRaw[0]) === JSON.stringify(["Order ID", "Qty"]), "expected normal plain-array sheets to still infer columns from the first row");

  // ---- A genuinely-populated sheet using the explicit {columns, rows} form also works (not just the empty case). ----
  const explicitBuf = await io.toExcelBytes({ order: { columns: ["A", "B"], rows: [{ A: 1, B: 2 }] } });
  const explicitWb = io.loadWorkbook(explicitBuf, "check4.xlsx");
  const explicitRaw = io.sheetToRawRows(explicitWb, "order", null);
  assert(JSON.stringify(explicitRaw[0]) === JSON.stringify(["A", "B"]) && explicitRaw[1][0] === 1 && explicitRaw[1][1] === 2, `expected explicit-form populated sheet to write correctly, got ${JSON.stringify(explicitRaw)}`);

  if (!ok) {
    console.error("\nEXPORT EMPTY SHEET HEADERS TEST FAILED");
    process.exit(1);
  }
  console.log("EXPORT EMPTY SHEET HEADERS TEST PASSED");
})();
