// Extracts Item number / Warehouse / Average unit cost / Inventory unit rows
// from a D365 "Inventory aging report" PDF export by reconstructing values
// from raw glyph positions (pdf.js text layer) — the PDF has no real table
// structure, and its numeric columns are sparse (a $0/blank cost renders as
// an empty cell, not "0.00", and different rows have different numbers of
// populated numeric cells), so column POSITION rather than column COUNTING
// is required to reliably find "Average unit cost" among ~16 numeric fields.
//
// Item number, Warehouse, and Inventory unit are each identified by content
// pattern (not position) since they have distinctive, unambiguous formats;
// only "Average unit cost" (a plain decimal indistinguishable by content
// from every other numeric column) needs the header's X position as an
// anchor, matched against the nearest numeric token in each row.

const AGING_PDF_ITEM_RE = /^IM8-[A-Za-z0-9]+-[A-Za-z0-9]+$/;
const AGING_PDF_WAREHOUSE_RE = /^U?S?OPS-?(WH|TRN)\d+/i;
// Warehouse codes are always "(US)OPS-WH0x" / "(US)OPS-TRN0x" — 1-3 digits.
// Captured separately from AGING_PDF_WAREHOUSE_RE (used only to detect a
// candidate token) because the "TRN01" code specifically sometimes has its
// hyphen dropped AND gets glued directly onto the following number with no
// space at all (e.g. "USOPSTRN01872.00") — a font-kerning/extraction quirk
// unique to that short code, not a real warehouse-naming difference. This
// pattern extracts just the true code, discarding whatever got glued on.
const AGING_PDF_WAREHOUSE_CODE_RE = /^(U?S?OPS-?(?:WH|TRN)\d{1,3})/i;
const AGING_PDF_UNIT_WORDS = new Set(["pcs", "box", "kit", "set", "pouch", "bottle", "pack"]);
const AGING_PDF_NUMBER_RE = /^-?[\d,]+\.\d{1,2}$/;
const AGING_PDF_COST_MAX_DIST = 20;
const AGING_PDF_ROW_Y_TOLERANCE = 2;

function fixWarehouseHyphen(raw) {
  return raw.replace(/^(U?S?OPS)(TRN|WH)/i, "$1-$2");
}

function cleanWarehouseCode(raw) {
  const match = raw.trim().match(AGING_PDF_WAREHOUSE_CODE_RE);
  return match ? fixWarehouseHyphen(match[1]) : fixWarehouseHyphen(raw.trim());
}

function groupItemsIntoRows(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const rows = [];
  for (const it of sorted) {
    const group = rows.find((g) => Math.abs(g.y - it.y) <= AGING_PDF_ROW_Y_TOLERANCE);
    if (group) group.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }
  return rows;
}

function findCostAnchorX(items) {
  const costLabel = items.find((it) => it.str.trim().toLowerCase() === "cost");
  if (costLabel) return costLabel.x;
  const combined = items.find((it) => /average unit/i.test(it.str));
  return combined ? combined.x : null;
}

// pdfjsLib: the pdf.js library object (window.pdfjsLib in-browser, or the
// required module in Node tests) — passed in rather than required directly
// so this file works in both environments without a hard browser/Node split.
async function extractAgingRowsFromPdf(pdfjsLib, fileBytes) {
  // pdf.js rejects Node Buffers explicitly (even though Buffer extends
  // Uint8Array) — only skip the copy for an actual plain Uint8Array.
  const isPlainUint8Array = fileBytes instanceof Uint8Array && fileBytes.constructor === Uint8Array;
  const data = isPlainUint8Array ? fileBytes : new Uint8Array(fileBytes);
  const pdf = await pdfjsLib.getDocument({ data }).promise;

  let costAnchorX = null;
  const records = [];
  // Rows with a real item number but no resolvable warehouse token — either
  // genuinely blank, or (rarely, seen with short codes like "TRN01") the
  // code's characters are simply absent from this PDF's text layer, a font-
  // encoding gap that can't be recovered from text alone. Surfaced rather
  // than silently dropped.
  const skippedNoWarehouse = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const items = content.items
      .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }))
      .filter((it) => it.str.trim() !== "");
    if (!items.length) continue;

    if (costAnchorX == null) costAnchorX = findCostAnchorX(items);

    for (const group of groupItemsIntoRows(items)) {
      const rowItems = group.items.slice().sort((a, b) => a.x - b.x);
      const itemTok = rowItems.find((it) => AGING_PDF_ITEM_RE.test(it.str.trim()));
      if (!itemTok) continue; // not a data row (header/blank/wrapped product-name continuation/totals)
      const whTok = rowItems.find((it) => AGING_PDF_WAREHOUSE_RE.test(it.str.trim()));
      if (!whTok) {
        const fragment = rowItems.find((it) => it.x > itemTok.x && it.x < itemTok.x + 260 && /OPS/i.test(it.str));
        skippedNoWarehouse.push({ item: itemTok.str.trim(), page: pageNum, fragment: fragment ? fragment.str.trim() : null });
        continue;
      }

      const unitTok = rowItems.find((it) => it.x < whTok.x && AGING_PDF_UNIT_WORDS.has(it.str.trim().toLowerCase()));

      let cost = null;
      if (costAnchorX != null) {
        let best = null;
        let bestDist = Infinity;
        for (const it of rowItems) {
          if (it.x <= whTok.x || !AGING_PDF_NUMBER_RE.test(it.str.trim())) continue;
          const dist = Math.abs(it.x - costAnchorX);
          if (dist < bestDist) {
            bestDist = dist;
            best = it;
          }
        }
        if (best && bestDist <= AGING_PDF_COST_MAX_DIST) cost = parseFloat(best.str.trim().replace(/,/g, ""));
      }

      records.push({
        "Item number": itemTok.str.trim(),
        Warehouse: cleanWarehouseCode(whTok.str),
        "Average unit cost": cost,
        "Inventory unit": unitTok ? unitTok.str.trim() : null,
      });
    }
  }

  const header = ["Item number", "Warehouse", "Average unit cost", "Inventory unit"];
  const raw = [header, ...records.map((r) => header.map((h) => r[h]))];
  return {
    raw,
    diagnostics: {
      pageCount: pdf.numPages,
      rowsExtracted: records.length,
      rowsSkippedNoWarehouse: skippedNoWarehouse.length,
      skippedNoWarehouseSample: skippedNoWarehouse.slice(0, 20),
    },
  };
}

if (typeof window !== "undefined") {
  window.pdfExtract = { extractAgingRowsFromPdf };
}
if (typeof module !== "undefined") {
  module.exports = { extractAgingRowsFromPdf };
}
