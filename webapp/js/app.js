// Prenetics Ops Tool — browser-only UI (no server). Mirrors app.py's behavior:
// auto-detect sheet/header/columns, auto-compute on upload, collapsed
// "fix detection" panel that only expands when something needed attention.

// The real, fixed set of warehouse codes across both entities (H007/U001).
// Used to seed filename auto-detection and manual override dropdowns so a
// warehouse is always selectable/detectable even when the currently-loaded
// data file doesn't happen to contain any rows for it yet.
const KNOWN_WAREHOUSES = ["OPS-WH01", "OPS-WH02", "OPS-WH03", "USOPS-WH04", "USOPS-WH05"];

const TASK_A_REQUESTED_CANDIDATES = {
  item: ["item number", "sku", "item no", "item"],
  warehouse: ["warehouse", "site"],
  qty: ["requested qty", "requested quantity", "quantity", "qty", "ordered qty"],
  remarks: ["remarks"],
};
const TASK_A_ONHAND_CANDIDATES = {
  item: ["item number", "sku", "item no", "item"],
  warehouse: ["warehouse", "site"],
  available: ["available physical", "available physical qty", "available qty"],
  product_name: ["product name", "item name", "description"],
};
const TASK_A_ONORDER_CANDIDATES = {
  item: ["item number", "sku", "item no", "item"],
  warehouse: ["warehouse", "site"],
  qty: ["on order qty", "on order", "ordered qty", "on-order qty", "incoming qty", "quantity"],
};
const TASK_B_OPEN_SO_CANDIDATES = {
  so_number: ["sales order", "sales order number", "so number"],
  shopify_ref: ["shopify reference", "shopify ref", "reference"],
  item: ["item number", "sku", "item"],
  warehouse: ["warehouse", "site"],
  qty: ["ordered qty", "quantity", "qty"],
  remarks: ["remarks"],
};
const TASK_B_FULFILLMENT_CANDIDATES = {
  so_number: ["sales order", "sales order number", "so number", "reference order no"],
  shopify_ref: ["shopify reference", "shopify ref", "reference", "platform order no", "order number", "custom reference"],
  item: ["sku", "item number", "item"],
  bundle_item: ["bundle sku", "bundle item", "bundle item number"],
  shipped_qty: ["shipped qty", "shipped quantity", "qty shipped", "quantity", "outbound qty", "quantity shipped"],
  tracking: ["tracking number", "tracking no", "awb", "tracking"],
  shipped_date: ["shipped date", "ship date", "line ship date", "date shipped", "outbound time", "order shipped at"],
  status: ["status", "fulfillment status", "order status"],
};

const TASK_C_BATCH_CANDIDATES = {
  shopify_ref: ["shopify reference", "shopify ref", "reference"],
  so_number: ["sales order", "sales order number"],
  item: ["item number", "sku", "item"],
  product_name: ["product name"],
  qty: ["quantity", "qty"],
  warehouse: ["warehouse", "site"],
  ship_date: ["ship date"],
  status: ["status"],
};
const TASK_C_ONHAND_CANDIDATES = {
  item: ["item number", "sku", "item"],
  warehouse: ["warehouse", "site"],
  available: ["available physical", "available physical qty"],
  batch: ["batch number", "batch"],
  product_name: ["product name"],
  manufacturer: ["manufacturer information", "manufacturer"],
  unit: ["inventory unit", "unit"],
};
const TASK_C_AGING_CANDIDATES = {
  item: ["item number", "sku", "item"],
  warehouse: ["warehouse", "site"],
  cost: ["average unit cost", "cost", "unit cost"],
  unit: ["inventory unit", "unit"],
};

const FIELD_LABELS = {
  item: "Item number / SKU", warehouse: "Warehouse", qty: "Quantity",
  available: "Available physical (on-hand)", product_name: "Product name",
  so_number: "Sales order number", shopify_ref: "Shopify reference", remarks: "Remarks",
  bundle_item: "Bundle SKU", shipped_qty: "Shipped qty", tracking: "Tracking number",
  shipped_date: "Shipped date", status: "Status", ship_date: "Ship date", batch: "Batch number",
  manufacturer: "Manufacturer information", unit: "Unit", cost: "Average unit cost",
};
const OPTIONAL_FIELDS = new Set([
  "product_name", "remarks", "bundle_item", "status", "shopify_ref", "so_number",
  "ship_date", "manufacturer", "unit",
]);

function h(tag, props, children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  (children || []).forEach((c) => c && el.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
  return el;
}

function fmtDate(v) {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

function todayStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function inferFacility(warehouses) {
  for (const wh of warehouses) {
    if (String(wh).toUpperCase().startsWith("USOPS-")) return "U001";
  }
  return "H007";
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// A cell value can be a live-formula marker ({formula, result} — see
// io.toExcelBytes/ExcelJS) rather than a plain value; show its cached result,
// not the object itself (String({...}) would print "[object Object]").
function formatCellForDisplay(v) {
  if (v instanceof Date) return fmtDate(v);
  if (v && typeof v === "object" && "formula" in v) return String(v.result);
  return v == null ? "" : String(v);
}

// rowClassFn(row, index) -> optional CSS class name (e.g. "row-red"/"row-green")
function renderTable(rows, container, limit, rowClassFn) {
  container.innerHTML = "";
  if (!rows.length) {
    container.appendChild(h("p", { class: "muted", text: "(no rows)" }));
    return;
  }
  const columns = Object.keys(rows[0]).filter((c) => !c.startsWith("__"));
  const shown = limit ? rows.slice(0, limit) : rows;
  const table = h("table", { class: "data-table" });
  const thead = h("thead", {}, [h("tr", {}, columns.map((c) => h("th", { text: c })))]);
  const tbody = h(
    "tbody",
    {},
    shown.map((row, idx) => {
      const cls = rowClassFn ? rowClassFn(row, idx) : null;
      return h(
        "tr",
        cls ? { class: cls } : {},
        columns.map((c) => h("td", { text: formatCellForDisplay(row[c]) }))
      );
    })
  );
  table.appendChild(thead);
  table.appendChild(tbody);
  container.appendChild(table);
  if (limit && rows.length > limit) {
    container.appendChild(h("p", { class: "muted", text: `... and ${rows.length - limit} more rows (full data is in the downloaded file)` }));
  }
}

// Small colored pill for "Dispatched" (green) / "Not Dispatched" (pink) —
// same palette as the row-green/row-red table highlight, so status reads
// consistently in prose, headers, and table rows alike.
function statusChip(status) {
  const isDispatched = status === "Dispatched";
  return h("span", {
    class: `status-chip ${isDispatched ? "status-chip-dispatched" : "status-chip-not-dispatched"}`,
    text: status,
  });
}

// A one-line row-count summary + a "View details" toggle that lazily renders
// the full table only once clicked (and tears it back down on collapse) —
// some of these result sets run into the hundreds/thousands of rows, where
// showing every line inline by default is unusable. label can be a plain
// string or an array of strings/nodes (e.g. to embed a statusChip inline).
function renderCollapsibleTable(container, label, rows, limit, rowClassFn) {
  const labelParts = Array.isArray(label) ? label : [label];
  container.appendChild(h("p", { class: "caption" }, [...labelParts, ` — ${rows.length} row(s)`]));
  const toggleBtn = h("button", { class: "clear-btn", text: "View details" });
  const tblContainer = h("div", {});
  toggleBtn.addEventListener("click", () => {
    const expanded = toggleBtn.dataset.expanded === "1";
    if (expanded) {
      tblContainer.innerHTML = "";
      toggleBtn.textContent = "View details";
      toggleBtn.dataset.expanded = "0";
    } else {
      renderTable(rows, tblContainer, limit || 200, rowClassFn);
      toggleBtn.textContent = "Hide details";
      toggleBtn.dataset.expanded = "1";
    }
  });
  container.appendChild(toggleBtn);
  container.appendChild(tblContainer);
}

// ---- "ops2" panel chrome (split input/output columns, required/optional
// file counts, sticky run button, output-preview empty state) — purely
// presentational plumbing for the redesigned layout. Never touches the real
// validation/compute logic in each task's own renderTaskX(), which stays the
// single source of truth for whether a file is actually usable (not just
// "chosen") — these helpers only drive cosmetic counters and the button's
// enabled/disabled state, called from renderTaskX() at the same points it
// already used to render its own "upload more files" message / run button.
function ops2FileFilled(input) {
  if (!input) return false;
  if (input.type === "file") return !!(input.files && input.files.length);
  if (input.tagName === "TEXTAREA") return input.value.trim().length > 0;
  return !!input.value;
}
function ops2InitFileCounts(panelId, requiredIds, optionalIds) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const reqInputs = requiredIds.map((id) => document.getElementById(id)).filter(Boolean);
  const optInputs = (optionalIds || []).map((id) => document.getElementById(id)).filter(Boolean);
  const countEl = panel.querySelector("[data-required-count]");
  const optCountEl = panel.querySelector("[data-optional-count]");
  function refresh() {
    if (countEl) countEl.textContent = `${reqInputs.filter(ops2FileFilled).length} of ${reqInputs.length} added`;
    if (optCountEl && optInputs.length) {
      const n = optInputs.filter(ops2FileFilled).length;
      optCountEl.textContent = n > 0 ? `${n} added` : "improve the output";
    }
  }
  reqInputs.concat(optInputs).forEach((input) => {
    input.addEventListener("change", refresh);
    if (input.tagName === "TEXTAREA") input.addEventListener("input", refresh);
  });
  refresh();
}
function ops2InitEmptyState(panelId) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const results = panel.querySelector('[id$="-results"]');
  const empty = panel.querySelector(".ops2-empty");
  if (!results || !empty) return;
  const toggle = () => { empty.style.display = results.children.length ? "none" : ""; };
  toggle();
  new MutationObserver(toggle).observe(results, { childList: true });
}
// ready: whether the task's own validation currently considers a run
// possible; missing: how many required files are still needed (helper text
// only). Called from inside each renderTaskX() at its existing gating points.
function ops2SyncRun(panelId, ready, missing) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const btn = panel.querySelector(".ops2-runwrap button.run-btn");
  const helper = panel.querySelector(".ops2-runwrap [data-helper]");
  if (btn) btn.disabled = !ready;
  if (helper) helper.textContent = ready ? "" : missing > 0 ? `Add ${missing} more file${missing === 1 ? "" : "s"} to run.` : "";
}

// XLSX parsing (SheetJS) is synchronous and blocks the main thread, so the
// overlay must actually paint (two animation frames — one to flush the class
// change, one to guarantee the browser composited it) before the blocking
// work starts, or the user never sees it at all.
function showLoadingOverlay(text) {
  const overlay = document.getElementById("loading-overlay");
  document.getElementById("loading-overlay-text").textContent = text || "Loading file...";
  overlay.classList.remove("hidden");
}
function hideLoadingOverlay() {
  document.getElementById("loading-overlay").classList.add("hidden");
}
// A setTimeout yield (not requestAnimationFrame) — rAF only fires once the
// page is actually compositing, which isn't guaranteed (e.g. a backgrounded
// or not-yet-visible tab), and would hang the whole load indefinitely.
function nextPaint() {
  return new Promise((resolve) => setTimeout(resolve, 50));
}
async function withLoading(label, fn) {
  showLoadingOverlay(label);
  await nextPaint();
  try {
    await fn();
  } finally {
    hideLoadingOverlay();
  }
}

async function loadWorkbookOrCsv(file) {
  const buf = await file.arrayBuffer();
  if (io.isExcelFilename(file.name)) {
    const wb = io.loadWorkbook(buf, file.name);
    return { kind: "xlsx", wb, sheets: io.listSheets(wb) };
  }
  if (/\.pdf$/i.test(file.name)) {
    // A D365 "Inventory aging report" PDF export — no real table structure,
    // reconstructed from text-layer glyph positions (see pdf_extract.js).
    // Reusing the "csv" shape (raw 2D array, no sheets) means the existing
    // sheet/header/column-detection UI below works unchanged for PDFs too.
    const { raw, diagnostics } = await pdfExtract.extractAgingRowsFromPdf(pdfjsLib, buf);
    return { kind: "csv", raw, sheets: null, pdfDiagnostics: diagnostics };
  }
  const text = new TextDecoder("utf-8").decode(buf);
  return { kind: "csv", raw: io.parseCsv(text), sheets: null };
}

function loadRows(source, sheetName, headerRow) {
  let rows;
  if (source.kind === "xlsx") {
    rows = io.loadTableFromSheet(source.wb, sheetName, headerRow);
  } else {
    rows = io.loadTableFromRawRows(source.raw, headerRow);
  }
  if (rows.length && io.hasSkuBlocks(Object.keys(rows[0]))) rows = io.unpivotSkuBlocks(rows);
  return rows;
}

function guessSheetAndHeader(source, candidates) {
  if (source.kind === "csv") {
    const g = io.guessHeaderRowAndScore(source.raw, candidates);
    return { sheet: null, row: g.row };
  }
  if (source.sheets.length > 1) return io.pickBestSheet(source.wb, candidates);
  const preview = io.sheetToRawRows(source.wb, source.sheets[0], 20);
  const g = io.guessHeaderRowAndScore(preview, candidates);
  return { sheet: source.sheets[0], row: g.row };
}

// Full read -> sheet/header auto-detect -> column-mapping UI, with an
// override panel for sheet/header/columns (mirrors app.py's load_uploaded_file).
// Returns a single mutable state object whose .rows/.colMap always reflect
// the current UI selections — callers should re-read from it, not capture a
// snapshot, since sheet/header changes reload the rows entirely.
async function setupFileUI(container, file, candidates, extraOptional) {
  const optionalFields = new Set([...OPTIONAL_FIELDS, ...(extraOptional || [])]);
  const source = await loadWorkbookOrCsv(file);
  const best = guessSheetAndHeader(source, candidates);

  const state = { rows: [], colMap: {}, getMissing: () => [], onChange: null };
  state.getMissing = () => Object.keys(candidates).filter((f) => !optionalFields.has(f) && !state.colMap[f]);

  const caption = h("p", { class: "caption" });
  const details = h("details", {});
  const summary = h("summary", {});
  details.appendChild(summary);
  const overrideBox = h("div", {});
  details.appendChild(overrideBox);
  const grid = h("div", { class: "col-grid" });
  details.appendChild(grid);
  const errorBox = h("p", { class: "error" });

  let sheetName = best.sheet;
  let headerRow = best.row;

  function rebuildColumnGrid(columns, guesses) {
    grid.innerHTML = "";
    for (const field of Object.keys(candidates)) {
      const isOptional = optionalFields.has(field);
      const wrap = h("div", { class: "col-field" });
      wrap.appendChild(h("label", { text: FIELD_LABELS[field] || field }));
      const select = h("select", {});
      if (isOptional) select.appendChild(h("option", { value: "" }, ["-- none --"]));
      columns.forEach((c) => select.appendChild(h("option", { value: c }, [c])));
      select.value = state.colMap[field] || "";
      select.addEventListener("change", () => {
        state.colMap[field] = select.value || null;
        refreshErrorAndNotify();
      });
      wrap.appendChild(select);
      grid.appendChild(wrap);
    }
  }

  function refreshErrorAndNotify() {
    const missing = state.getMissing();
    errorBox.textContent = missing.length
      ? "Missing required column(s) — open the panel above to pick them manually: " + missing.map((f) => FIELD_LABELS[f] || f).join(", ")
      : "";
    if (missing.length) details.open = true;
    if (state.onChange) state.onChange();
  }

  function reload() {
    state.rows = loadRows(source, sheetName, headerRow);
    const columns = state.rows.length ? Object.keys(state.rows[0]) : [];
    const guesses = {};
    for (const [field, candList] of Object.entries(candidates)) guesses[field] = io.fuzzyMatchColumn(columns, candList);
    state.colMap = { ...guesses };

    const detected = Object.entries(guesses).filter(([, v]) => v).map(([f, v]) => `${FIELD_LABELS[f] || f} → '${v}'`).join(", ");
    caption.textContent = `Loaded ${state.rows.length} rows from '${sheetName || "(csv)"}', header row ${headerRow}. Detected: ${detected}`;
    summary.textContent = "Fix detected columns / sheet / header row";

    rebuildColumnGrid(columns, guesses);
    refreshErrorAndNotify();
  }

  overrideBox.innerHTML = "";
  if (source.sheets && source.sheets.length > 1) {
    const sheetSelect = h("select", {});
    source.sheets.forEach((s) => sheetSelect.appendChild(h("option", { value: s }, [s])));
    sheetSelect.value = sheetName;
    sheetSelect.addEventListener("change", () => { sheetName = sheetSelect.value; reload(); });
    overrideBox.appendChild(h("label", { text: "Sheet: " }, [sheetSelect]));
  }
  const headerInput = h("input", { type: "number", min: "0", max: "19" });
  headerInput.value = String(headerRow);
  headerInput.addEventListener("change", () => { headerRow = parseInt(headerInput.value, 10) || 0; reload(); });
  overrideBox.appendChild(h("label", { text: " Header row (0 = first row): " }, [headerInput]));

  container.appendChild(caption);
  if (source.pdfDiagnostics) {
    const d = source.pdfDiagnostics;
    const msg = `Extracted from PDF (${d.pageCount} pages): ${d.rowsExtracted} item/warehouse rows read` +
      (d.rowsSkippedNoWarehouse ? `, ${d.rowsSkippedNoWarehouse} row(s) skipped (warehouse code unreadable in this PDF — usually a rare/transit code, not a real operational warehouse).` : ".");
    container.appendChild(h("p", { class: d.rowsSkippedNoWarehouse ? "warning" : "info", text: msg }));
  }
  container.appendChild(details);
  container.appendChild(errorBox);

  reload();
  return state;
}

function buildRemarksFilterUI(container, rows, remarkCol, defaultValues, onChange) {
  if (!remarkCol) return { filteredRows: rows };
  const values = Array.from(new Set(rows.map((r) => (r[remarkCol] == null ? null : String(r[remarkCol]))).filter((v) => v != null))).sort();
  const defaults = values.filter((v) => defaultValues.includes(v));
  const selected = new Set(defaults.length ? defaults : values);

  const details = h("details", {});
  details.appendChild(h("summary", { text: `Remarks filter (defaulting to: ${Array.from(selected).join(", ")})` }));
  const box = h("div", { class: "checkbox-list" });
  values.forEach((v) => {
    const id = "remarks_" + Math.random().toString(36).slice(2);
    const cb = h("input", { type: "checkbox", id });
    cb.checked = selected.has(v);
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(v);
      else selected.delete(v);
      onChange(rows.filter((r) => selected.has(String(r[remarkCol]))));
    });
    const label = h("label", { for: id }, [cb, " " + v]);
    box.appendChild(label);
  });
  details.appendChild(box);
  container.appendChild(details);

  return { filteredRows: rows.filter((r) => selected.has(String(r[remarkCol]))) };
}

// ---------------- Task A ----------------

// Item master (Item number -> Product name), saved in this browser's
// localStorage so it persists across sessions without any server — used only
// to backfill Product name for SKUs with zero rows in the on-hand export.
const ITEM_MASTER_STORAGE_KEY = "im8OpsToolItemMasterV1";

function loadItemMasterFromStorage() {
  try {
    const raw = localStorage.getItem(ITEM_MASTER_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}
function saveItemMasterToStorage(map) {
  try {
    localStorage.setItem(ITEM_MASTER_STORAGE_KEY, JSON.stringify(map));
  } catch (e) {
    // Storage disabled/full — the map still works for this page load, it
    // just won't persist to the next session.
  }
}

const itemMasterState = { map: loadItemMasterFromStorage() };

function renderItemMasterStatus() {
  const box = document.getElementById("task-a-item-master-status");
  if (!box) return;
  const count = Object.keys(itemMasterState.map).length;
  box.textContent = count
    ? `${count} item(s) saved in this browser and used to backfill missing Product names.`
    : "No item master saved yet in this browser — upload a file above to add one.";
}

async function handleTaskAItemMasterFile(file) {
  if (!file) return;
  const source = await loadWorkbookOrCsv(file);
  const candidates = { item: ["item number", "sku", "item"], product_name: ["product name", "item name", "name", "description"] };
  const best = guessSheetAndHeader(source, candidates);
  const rows = loadRows(source, best.sheet, best.row);
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const itemCol = io.fuzzyMatchColumn(cols, candidates.item);
  const nameCol = io.fuzzyMatchColumn(cols, candidates.product_name);
  const status = document.getElementById("task-a-item-master-status");
  if (!itemCol || !nameCol) {
    status.textContent = `Couldn't detect Item number / Product name columns in that file (found: ${cols.join(", ")}).`;
    return;
  }
  let added = 0;
  for (const r of rows) {
    const item = r[itemCol];
    const name = r[nameCol];
    if (item == null || String(item).trim() === "" || name == null || String(name).trim() === "") continue;
    itemMasterState.map[String(item).trim()] = String(name).trim();
    added++;
  }
  saveItemMasterToStorage(itemMasterState.map);
  renderItemMasterStatus();
  status.textContent += ` (${added} row(s) added/updated from this file.)`;
  taskAState.hasRun = false;
  renderTaskA();
}

function clearTaskAItemMaster() {
  itemMasterState.map = {};
  saveItemMasterToStorage(itemMasterState.map);
  renderItemMasterStatus();
  taskAState.hasRun = false;
  renderTaskA();
}

const taskAState = { requested: null, onhand: null, onorder: null, hasRun: false };

function taskARowClass(row) {
  if (row["Item number"] === TOTALS_LABEL) return null;
  return row["To produce"] > 0 ? "row-red" : "row-green";
}

function renderTaskA() {
  const root = document.getElementById("task-a-results");
  root.innerHTML = "";
  const { requested, onhand, onorder } = taskAState;
  if (!requested || !onhand) {
    ops2SyncRun("tab-a", false, (!requested ? 1 : 0) + (!onhand ? 1 : 0));
    return;
  }
  if (requested.getMissing().length || onhand.getMissing().length) { ops2SyncRun("tab-a", false, 0); return; }
  if (onorder && onorder.getMissing().length) { ops2SyncRun("tab-a", false, 0); return; }

  if (!taskAState.hasRun) {
    ops2SyncRun("tab-a", true, 0);
    return;
  }
  ops2SyncRun("tab-a", true, 0);

  let filteredRows = requested.rows;
  const remarksContainer = h("div", {});
  root.appendChild(remarksContainer);
  const { filteredRows: fr } = buildRemarksFilterUI(
    remarksContainer, requested.rows, requested.colMap.remarks, ["IT - to rerun fulfillment"],
    (newRows) => { filteredRows = newRows; recompute(); }
  );
  filteredRows = fr;

  const showAllWrap = h("label", { class: "checkbox-inline" });
  const showAllCb = h("input", { type: "checkbox" });
  showAllCb.checked = true;
  showAllWrap.appendChild(showAllCb);
  showAllWrap.appendChild(document.createTextNode(" Show all rows (highlight shortfalls) — uncheck to show only shortfall rows"));
  root.appendChild(showAllWrap);

  const diagBox = h("details", {}, [h("summary", { text: "Summary / diagnostics" }), h("pre", { class: "diagnostics" })]);
  root.appendChild(diagBox);
  const tablesArea = h("div", {});
  root.appendChild(tablesArea);

  function recompute() {
    const showAllRows = showAllCb.checked;
    const { perWarehouse, diagnostics } = computeProductionRequirement(
      filteredRows, onhand.rows, requested.colMap, onhand.colMap, showAllRows,
      onorder ? onorder.rows : null, onorder ? onorder.colMap : null, itemMasterState.map
    );
    diagBox.querySelector(".diagnostics").textContent = JSON.stringify(diagnostics, null, 2);

    tablesArea.innerHTML = "";
    if (!Object.keys(perWarehouse).length) {
      tablesArea.appendChild(h("p", { class: "warning", text: "No output rows produced — check the column mappings and Remarks filter above." }));
      return;
    }

    const allRowColors = {};
    for (const [wh, table] of Object.entries(perWarehouse)) {
      allRowColors[wh] = table.map((r) => (r["Item number"] === TOTALS_LABEL ? null : r["To produce"] > 0 ? "red" : "green"));
    }
    const allBtn = h("button", { text: "Download all warehouses (.xlsx, one tab per warehouse)" });
    allBtn.addEventListener("click", async () => {
      allBtn.disabled = true;
      allBtn.textContent = "Building file...";
      try {
        const buf = await io.toExcelBytes(perWarehouse, allRowColors);
        downloadBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${todayStamp()}_All_Warehouses_Production_Requirement.xlsx`);
      } finally {
        allBtn.disabled = false;
        allBtn.textContent = "Download all warehouses (.xlsx, one tab per warehouse)";
      }
    });
    tablesArea.appendChild(allBtn);

    for (const [wh, table] of Object.entries(perWarehouse)) {
      const rowColors = allRowColors[wh];
      tablesArea.appendChild(h("h4", { text: `${wh} — ${table.length - 1} SKU rows` }));

      const btn = h("button", { text: `Download ${wh} result (.xlsx)` });
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Building file...";
        try {
          const buf = await io.toExcelBytes({ [wh]: table }, { [wh]: rowColors });
          downloadBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${todayStamp()}_${wh}_Production_Requirement.xlsx`);
        } finally {
          btn.disabled = false;
          btn.textContent = `Download ${wh} result (.xlsx)`;
        }
      });
      tablesArea.appendChild(btn);

      const tblContainer = h("div", {});
      tablesArea.appendChild(tblContainer);
      renderTable(table, tblContainer, 200, taskARowClass);
    }
  }
  showAllCb.addEventListener("change", recompute);
  recompute();
}

const TASK_A_FILE_CONFIG = {
  requested: { candidates: TASK_A_REQUESTED_CANDIDATES, containerId: "task-a-requested-info" },
  onhand: { candidates: TASK_A_ONHAND_CANDIDATES, containerId: "task-a-onhand-info" },
  onorder: { candidates: TASK_A_ONORDER_CANDIDATES, containerId: "task-a-onorder-info" },
};

// If the "requested" upload is a full Open SO workbook (not a pre-filtered
// flat export), it carries the authoritative requested-qty source: a
// pre-built Item x Warehouse PivotTable in its Action/Actions tab (see
// production_shortfall_report_spec.md). Returns null (caller falls back to
// normal flat-file handling) if no such tab/pivot is found — not an error,
// just "this upload isn't that shape".
async function tryLoadTaskARequestedPivot(container, file) {
  if (!io.isExcelFilename(file.name)) return null;
  const buf = await file.arrayBuffer();
  const wb = io.loadWorkbook(buf, file.name);
  const sheets = io.listSheets(wb) || [];
  const actionSheet =
    sheets.find((s) => taskC.normText(s) === "action") ||
    sheets.find((s) => taskC.normText(s) === "actions") ||
    sheets.find((s) => taskC.normText(s).includes("action")) ||
    null;
  if (!actionSheet) return null;

  const raw = io.sheetToRawRows(wb, actionSheet, null);
  const pivot = taskA.extractItemWarehousePivot(raw);
  if (!pivot) return null;

  const rows = taskA.pivotToFlatRequestedRows(pivot);
  container.appendChild(
    h("p", {
      class: "info",
      text: `Detected the "${actionSheet}" tab's pre-built Requested-qty pivot (per the Production Shortfall spec) — using it directly instead of a flat file/Remarks filter. Warehouses: ${pivot.warehouses.join(", ")}. Items: ${pivot.items.length}.`,
    })
  );
  container.appendChild(
    h("p", {
      class: pivot.validation.mismatches.length ? "warning" : "caption",
      text: pivot.validation.mismatches.length
        ? `Grand Total validation MISMATCH — double-check this pivot before trusting the run: ${JSON.stringify(pivot.validation.mismatches)}`
        : "Grand Total validated: per-warehouse sums match the pivot's own totals.",
    })
  );

  return { rows, colMap: { item: "Item number", warehouse: "Warehouse", qty: "Quantity", remarks: null }, getMissing: () => [], onChange: null };
}

async function handleTaskAFile(kind, file) {
  const { candidates, containerId } = TASK_A_FILE_CONFIG[kind];
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  taskAState.hasRun = false;
  if (!file) {
    taskAState[kind] = null;
    renderTaskA();
    return;
  }

  if (kind === "requested") {
    const pivotState = await tryLoadTaskARequestedPivot(container, file);
    if (pivotState) {
      taskAState.requested = pivotState;
      renderTaskA();
      return;
    }
  }

  const state = await setupFileUI(container, file, candidates, null);
  state.onChange = () => { taskAState.hasRun = false; renderTaskA(); };
  taskAState[kind] = state;
  renderTaskA();
}

// ---------------- Task B ----------------

const taskBState = { openSo: null, fulfillmentFiles: [], onhand: null };

async function handleTaskBOnhand(file) {
  const container = document.getElementById("task-b-onhand-info");
  container.innerHTML = "";
  if (!file) {
    taskBState.onhand = null;
    renderTaskB();
    return;
  }
  const state = await setupFileUI(container, file, TASK_C_ONHAND_CANDIDATES, null);
  state.onChange = () => renderTaskB();
  taskBState.onhand = state;
  renderTaskB();
}

function knownWarehouses() {
  const discovered = taskBState.openSo
    ? taskBState.openSo.rows.map((r) => {
        const col = taskBState.openSo.colMap.warehouse;
        const v = r[col];
        return v == null || String(v).trim() === "" ? "Unassigned" : String(v);
      })
    : [];
  return Array.from(new Set([...KNOWN_WAREHOUSES, ...discovered])).sort();
}

function renderTaskB() {
  const root = document.getElementById("task-b-results");
  root.innerHTML = "";
  const { openSo, fulfillmentFiles } = taskBState;
  if (!openSo || !fulfillmentFiles.length) {
    ops2SyncRun("tab-b", false, (!openSo ? 1 : 0) + (!fulfillmentFiles.length ? 1 : 0));
    return;
  }
  if (openSo.getMissing().length) { ops2SyncRun("tab-b", false, 0); return; }
  if (!openSo.colMap.so_number && !openSo.colMap.shopify_ref) {
    ops2SyncRun("tab-b", false, 0);
    root.appendChild(h("p", { class: "error", text: "The open sales order list needs a Sales order number or a Shopify reference column to join on." }));
    return;
  }
  ops2SyncRun("tab-b", true, 0);

  const parsed = [];
  for (const f of fulfillmentFiles) {
    if (!f.rows || f.getMissing().length) continue;
    if (!f.colMap.so_number && !f.colMap.shopify_ref) {
      f.errorBox.textContent = "This file needs a Sales order number or a Shopify reference column to join on.";
      continue;
    } else {
      f.errorBox.textContent = "";
    }
    parsed.push(f);
  }
  if (!parsed.length) {
    root.appendChild(h("p", { class: "warning", text: "No fulfillment report could be parsed — check the column mappings above." }));
    return;
  }

  const multiple = fulfillmentFiles.length > 1;
  if (multiple) {
    const assigned = parsed.map((f) => f.assignedWarehouse);
    if (assigned.includes("All warehouses")) {
      root.appendChild(h("p", { class: "error", text: "When uploading multiple fulfillment reports, each must be assigned to a specific warehouse (not 'All warehouses')." }));
      return;
    }
    const dupes = assigned.filter((wh, i) => assigned.indexOf(wh) !== i);
    if (dupes.length) {
      root.appendChild(h("p", { class: "error", text: `More than one report is assigned to: ${Array.from(new Set(dupes)).join(", ")}. Each warehouse needs exactly one report.` }));
      return;
    }
  }

  // Blank warehouse becomes its own "Unassigned" bucket from here on, so it
  // flows through the same matching/uncovered-warehouse logic as any real one.
  const whCol = openSo.colMap.warehouse;
  const soRowsNormalized = openSo.rows.map((r) => {
    const v = r[whCol];
    const blank = v == null || String(v).trim() === "";
    return blank ? { ...r, [whCol]: "Unassigned" } : r;
  });

  let filteredSoRows = soRowsNormalized;
  const remarksContainer = h("div", {});
  root.appendChild(remarksContainer);
  const { filteredRows: fr } = buildRemarksFilterUI(
    remarksContainer, soRowsNormalized, openSo.colMap.remarks,
    ["Ops - refund order", "Ops - to manually fulfil and adjust inventory"],
    (newRows) => { filteredSoRows = newRows; recompute(); }
  );
  filteredSoRows = fr;

  const diagBox = h("details", {}, [h("summary", { text: "Summary / diagnostics (per uploaded file)" }), h("pre", { class: "diagnostics" })]);
  root.appendChild(diagBox);
  const downloadArea = h("div", {});
  root.appendChild(downloadArea);
  const tablesArea = h("div", {});
  root.appendChild(tablesArea);
  const templateArea = h("div", {});
  root.appendChild(templateArea);

  function recompute() {
    const known = Array.from(new Set(filteredSoRows.map((r) => String(r[whCol])))).sort();
    let combinedPerSheet = {};
    const combinedDiagnostics = {};
    const covered = new Set();
    let allMatchRows = [];

    for (const f of parsed) {
      const wh = multiple ? f.assignedWarehouse : (f.assignedWarehouse || "All warehouses");
      let soSubset;
      if (wh === "All warehouses") {
        soSubset = filteredSoRows;
      } else {
        soSubset = filteredSoRows.filter((r) => String(r[whCol]) === wh);
        covered.add(wh);
      }
      if (!soSubset.length) continue;
      const { perSheet, diagnostics, rows: matchRows } = matchFulfillmentForWarehouse(soSubset, openSo.colMap, f.rows, f.colMap);
      combinedPerSheet = { ...combinedPerSheet, ...perSheet };
      combinedDiagnostics[f.name] = diagnostics;
      allMatchRows = allMatchRows.concat(matchRows);
    }

    if (multiple) {
      const uncovered = known.filter((wh) => !covered.has(wh));
      for (const wh of uncovered) {
        const soSubset = filteredSoRows.filter((r) => String(r[whCol]) === wh);
        if (!soSubset.length) continue;
        const emptyFulCols = { item: openSo.colMap.item, shipped_qty: "__shipped_qty", tracking: "__tracking", shipped_date: "__shipped_date" };
        const { perSheet, diagnostics, rows: matchRows } = matchFulfillmentForWarehouse(soSubset, openSo.colMap, [], emptyFulCols);
        combinedPerSheet = { ...combinedPerSheet, ...perSheet };
        combinedDiagnostics[`(no report uploaded for ${wh})`] = diagnostics;
        allMatchRows = allMatchRows.concat(matchRows);
      }
    }

    diagBox.querySelector(".diagnostics").textContent = JSON.stringify(combinedDiagnostics, null, 2);

    downloadArea.innerHTML = "";
    tablesArea.innerHTML = "";
    if (!Object.keys(combinedPerSheet).length) {
      tablesArea.appendChild(h("p", { class: "warning", text: "No output rows produced — check the column mappings above." }));
      return;
    }

    const rowColors = {};
    for (const [name, table] of Object.entries(combinedPerSheet)) {
      if (name.includes("(Partially Shipped)")) rowColors[name] = table.map((r) => (r["Outstanding qty"] > 0 ? "amber" : null));
    }

    // One download button per warehouse, bundling all of that warehouse's
    // status sheets (Shipped/Partially Shipped/Not Fulfilled) into one file.
    const sheetsByWarehouse = new Map();
    for (const name of Object.keys(combinedPerSheet)) {
      const wh = name.split(" (")[0];
      if (!sheetsByWarehouse.has(wh)) sheetsByWarehouse.set(wh, []);
      sheetsByWarehouse.get(wh).push(name);
    }
    for (const [wh, sheetNames] of sheetsByWarehouse.entries()) {
      const whSheetDict = {};
      const whRowColors = {};
      let rowCount = 0;
      sheetNames.forEach((name) => {
        whSheetDict[name] = combinedPerSheet[name];
        rowCount += combinedPerSheet[name].length;
        if (rowColors[name]) whRowColors[name] = rowColors[name];
      });
      const btn = h("button", { text: `Download ${wh} result (.xlsx)` });
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Building file...";
        try {
          const buf = await io.toExcelBytes(whSheetDict, whRowColors);
          downloadBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${todayStamp()}_${wh}_Fulfillment_Check.xlsx`);
        } finally {
          btn.disabled = false;
          btn.textContent = `Download ${wh} result (.xlsx)`;
        }
      });
      downloadArea.appendChild(btn);
      tablesArea.appendChild(h("h4", { text: `${wh} — ${rowCount} total rows across ${sheetNames.length} status sheet(s)` }));
    }

    for (const [name, table] of Object.entries(combinedPerSheet)) {
      tablesArea.appendChild(h("h4", { text: `${name} — ${table.length} rows` }));
      const tblContainer = h("div", {});
      tablesArea.appendChild(tblContainer);
      const isPartial = name.includes("(Partially Shipped)");
      renderTable(table, tblContainer, 200, isPartial ? (r) => (r["Outstanding qty"] > 0 ? "row-amber" : null) : null);
    }

    renderTaskBFulfillmentTemplate(templateArea, allMatchRows);
  }
  recompute();
}

// Builds the D365 fulfillment import template (one row per unit) for orders
// this run classified as fully "Shipped" — per Fulfillment_check.md. Batch
// numbers are allocated SEQUENTIALLY from the on-hand pool per Item+
// Warehouse, shared across every line in this run (task D's disposal-journal
// allocator, reused as-is) rather than an independent lookup per line, and
// flagged "Insufficient on-hand batch" if the pool runs dry. order_status is
// a netted total across an order's non-service lines, so an order can still
// net to "Shipped" while one line is under-shipped and another over-shipped
// — such lines stay IN the output (still really shipped) but get a per-row
// Flag rather than being silently trusted or dropped.
function renderTaskBFulfillmentTemplate(container, allMatchRows) {
  container.innerHTML = "";
  if (!allMatchRows.length) return;

  container.appendChild(h("h3", { text: "D365 fulfillment template — Dispatched/Shipped orders" }));

  const shippedRows = allMatchRows.filter((r) => r.order_status === "Shipped");
  const notFulfilledKeys = new Set(allMatchRows.filter((r) => r.order_status === "Not Fulfilled").map((r) => r.salesOrder || r.key));
  if (notFulfilledKeys.size) {
    container.appendChild(
      h("p", {
        class: "caption",
        text: `${notFulfilledKeys.size} order(s) had zero match in the fulfillment report — excluded from the template, follow up separately: ${Array.from(notFulfilledKeys).slice(0, 20).join(", ")}${notFulfilledKeys.size > 20 ? "..." : ""}`,
      })
    );
  }
  if (!shippedRows.length) {
    container.appendChild(h("p", { class: "muted", text: "No fully-Shipped orders in this run." }));
    return;
  }

  const lineShortfalls = shippedRows.filter((r) => !r.is_service && r.outstanding_qty > 0);
  if (lineShortfalls.length) {
    const flaggedKeys = new Set(lineShortfalls.map((r) => r.salesOrder || r.key));
    container.appendChild(
      h("p", {
        class: "warning",
        text: `${flaggedKeys.size} order(s) net to "Shipped" overall but have at least one SKU line still short (another line over-shipped enough to cover the total) — kept in the template below but flagged per-row, verify manually: ${Array.from(flaggedKeys).slice(0, 20).join(", ")}${flaggedKeys.size > 20 ? "..." : ""}`,
      })
    );
  }

  const onhand = taskBState.onhand;
  const onHandIndex = onhand && onhand.rows ? taskD.buildOnHandIndex(onhand.rows, onhand.colMap) : null;
  if (!onHandIndex) {
    container.appendChild(h("p", { class: "warning", text: "No on-hand report uploaded — Batch Number will be left blank for every line." }));
  }

  // order.originalLines is only set in order-level mode (the fulfillment
  // report has no per-SKU detail at all — e.g. Stord's summary export): the
  // order-level row itself carries a placeholder item and an inflated
  // whole-Shopify-order shipped_qty, neither fit for the D365 import
  // template. Once such an order is confirmed "Shipped" overall, re-expand
  // it back into its real per-SKU rerun lines (each getting its own ordered
  // qty — there's no per-SKU shipped detail to fall back on in this mode,
  // but the order-level status already confirms the whole thing went out).
  const shippedLines = [];
  for (const r of shippedRows) {
    const salesOrderId = r.salesOrder || r.key;
    if (r.originalLines && r.originalLines.length) {
      for (const line of r.originalLines) {
        shippedLines.push({
          item: line.item,
          warehouse: r.warehouse,
          salesOrder: salesOrderId,
          qty: line.qty,
          tracking: r.tracking_number,
          shippedDate: r.shipped_date,
          isService: isServiceSku(line.item),
          outstandingQty: 0,
          isMultiTracking: r.flag === MULTI_TRACKING_FLAG,
        });
      }
      continue;
    }
    // Service (SER) lines never appear in a warehouse fulfillment report at
    // all (they're a D365-only charge, not a physical pick/pack) — they will
    // NEVER have a real shipped_qty, so outstanding_qty > 0 for them is
    // normal and expected, not a real partial-shipment signal. Since the
    // order's non-service (FG) lines are already confirmed "Shipped" here,
    // always include the SER line at its full ordered_qty and don't flag it.
    // (An order whose FG lines never dispatched never reaches shippedRows in
    // the first place, so its SER lines are correctly excluded entirely.)
    // For real FG lines, use ordered_qty when this line isn't individually
    // under-shipped (outstanding_qty <= 0 — the normal case, where
    // shipped_qty equals it anyway); a per-SKU fulfillment report can still
    // occasionally over-report shipped_qty above ordered_qty, and
    // ordered_qty is always the safe/correct choice once "Shipped" is
    // already confirmed. Only fall back to the real shipped_qty when this
    // specific FG line is under-shipped (outstanding_qty > 0), since then
    // ordered_qty would overstate what actually went out on this line.
    shippedLines.push({
      item: r.item,
      warehouse: r.warehouse,
      salesOrder: salesOrderId,
      qty: r.is_service ? r.ordered_qty : r.outstanding_qty > 0 ? r.shipped_qty : r.ordered_qty,
      tracking: r.tracking_number,
      shippedDate: r.shipped_date,
      isService: r.is_service,
      outstandingQty: r.is_service ? 0 : r.outstanding_qty,
      isMultiTracking: r.flag === MULTI_TRACKING_FLAG,
    });
  }
  const { table: unitRows, multiTrackingOrders } = taskD.buildShippedFulfillmentTemplate(shippedLines, onHandIndex);

  if (multiTrackingOrders.length) {
    container.appendChild(h("p", { class: "warning", text: `${multiTrackingOrders.length} order(s) had multiple tracking numbers on the fulfillment report — the first one found was used for every line, verify manually: ${multiTrackingOrders.slice(0, 20).join(", ")}` }));
  }
  const insufficientCount = unitRows.filter((r) => r.Flag.includes("Insufficient on-hand batch")).length;
  if (insufficientCount) {
    container.appendChild(h("p", { class: "warning", text: `${insufficientCount} unit row(s) ran out of on-hand batch stock to allocate — Batch Number left blank for those, flagged "Insufficient on-hand batch".` }));
  }

  // Validation (per spec, run every time): output rows must equal the sum of
  // each confirmed-shipped line's own quantity — reuses shippedLines (the
  // exact input just built above) rather than recomputing the same rule a
  // second time and risking the two silently drifting apart.
  const expectedUnits = shippedLines.reduce((s, l) => s + Math.round(toNum(l.qty)), 0);
  container.appendChild(
    h("p", {
      class: expectedUnits === unitRows.length ? "caption" : "error",
      text: expectedUnits === unitRows.length
        ? `Validated: ${unitRows.length} output rows = sum of Quantity across all confirmed-shipped lines.`
        : `MISMATCH: ${unitRows.length} output rows vs. ${expectedUnits} expected — investigate before trusting this file.`,
    })
  );

  const btn = h("button", { text: "Download D365 fulfillment template — Dispatched (.xlsx)" });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Building file...";
    try {
      const buf = await io.toExcelBytes({ order: unitRows, "serial number": { columns: ["Order ID", "SKU Number", "Serial number"], rows: [] } });
      downloadBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${todayStamp()}_D365_Fulfillment_Dispatched.xlsx`);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
  container.appendChild(btn);
  container.appendChild(h("p", { class: "caption", text: `${unitRows.length} unit-rows across ${shippedRows.length} lines (${new Set(shippedRows.map((r) => r.key)).size} orders).` }));

  const tblContainer = h("div", {});
  container.appendChild(tblContainer);
  renderTable(unitRows, tblContainer, 200, (r) => (r.Flag ? "row-amber" : null));
}

async function handleTaskBOpenSo(file) {
  const container = document.getElementById("task-b-so-info");
  container.innerHTML = "";
  if (!file) {
    taskBState.openSo = null;
    renderTaskB();
    return;
  }
  const state = await setupFileUI(container, file, TASK_B_OPEN_SO_CANDIDATES, null);
  state.onChange = () => renderTaskB();
  taskBState.openSo = state;
  renderTaskB();
}

async function handleTaskBFulfillmentFiles(files) {
  const container = document.getElementById("task-b-ful-info");
  container.innerHTML = "";
  taskBState.fulfillmentFiles = [];
  if (!files.length) {
    renderTaskB();
    return;
  }
  const multiple = files.length > 1;
  for (const file of files) {
    const fileBox = h("div", { class: multiple ? "file-box" : "" });
    if (multiple) fileBox.appendChild(h("h4", { text: `📄 ${file.name}` }));
    container.appendChild(fileBox);

    const fileState = await setupFileUI(fileBox, file, TASK_B_FULFILLMENT_CANDIDATES, ["item"]);
    const orderLevelInfo = h("p", { class: "info" });
    fileBox.appendChild(orderLevelInfo);

    const errorBox = h("p", { class: "error" });
    fileBox.appendChild(errorBox);

    // Extend fileState in place (rather than spreading into a new object) so
    // its .rows/.colMap stay live if the user later changes sheet/header/columns.
    const state = fileState;
    state.name = file.name;
    state.errorBox = errorBox;
    state.orderLevelInfo = orderLevelInfo;
    const known = knownWarehouses();
    const guessedWh = io.guessWarehouseFromFilename(file.name, known);
    state.assignedWarehouse = guessedWh || "All warehouses";
    state.onChange = () => {
      orderLevelInfo.textContent = state.colMap.item == null
        ? "No SKU column found — this looks like an order-level shipping summary (no per-line detail). Matching will be done at the whole-order level."
        : "";
      renderTaskB();
    };
    state.onChange();

    if (multiple) {
      const select = h("select", {});
      select.appendChild(h("option", { value: "All warehouses" }, ["All warehouses"]));
      known.forEach((wh) => select.appendChild(h("option", { value: wh }, [wh])));
      select.value = state.assignedWarehouse;
      const label = h("label", { text: "Which warehouse is this report for? " }, [select]);
      fileBox.appendChild(label);
      select.addEventListener("change", () => {
        state.assignedWarehouse = select.value;
        renderTaskB();
      });
    } else if (guessedWh) {
      fileBox.appendChild(h("p", { class: "caption", text: `Applies to: ${state.assignedWarehouse} (detected from filename)` }));
    }

    taskBState.fulfillmentFiles.push(state);
  }
  renderTaskB();
}

// ---------------- Task C ----------------

const taskCState = { openso: null, batch: null, fulfillmentFiles: [], onhand: null, aging: null };

function taskCKnownWarehouses() {
  const discovered = taskCState.batch
    ? taskCState.batch.rows.map((r) => {
        const col = taskCState.batch.colMap.warehouse;
        const v = r[col];
        return v == null || String(v).trim() === "" ? "Unassigned" : String(v);
      })
    : [];
  // Always include the real fixed warehouse codes, not just whatever the
  // currently-loaded batch file happens to contain — otherwise a warehouse
  // absent from this run's data can neither be auto-detected from the
  // fulfillment-report filename nor picked manually from the dropdown.
  return Array.from(new Set([...KNOWN_WAREHOUSES, ...discovered])).sort();
}

async function handleTaskCOpenSo(file) {
  const container = document.getElementById("task-c-openso-info");
  container.innerHTML = "";
  if (!file) {
    taskCState.openso = null;
    renderTaskC();
    return;
  }
  const buf = await file.arrayBuffer();
  const wb = io.loadWorkbook(buf, file.name);
  const sheets = io.listSheets(wb) || [];
  const refundedOnSheet =
    sheets.find((s) => taskC.normText(s) === "refunded on") ||
    sheets.find((s) => taskC.normText(s).includes("refund")) ||
    null;
  const actionsSheet =
    sheets.find((s) => taskC.normText(s) === "actions") ||
    sheets.find((s) => taskC.normText(s) === "action") ||
    sheets.find((s) => taskC.normText(s).includes("action")) ||
    null;

  let refundedOnRows = [];
  let refundedOnCols = { so: null, date: null };
  if (refundedOnSheet) {
    const preview = io.sheetToRawRows(wb, refundedOnSheet, 20);
    const g = io.guessHeaderRowAndScore(preview, { so_number: ["sales order"], date: ["created date and time", "ship date"] });
    const fullRaw = io.sheetToRawRows(wb, refundedOnSheet, null);
    refundedOnRows = io.loadTableFromRawRows(fullRaw, g.row);
    const cols = refundedOnRows.length ? Object.keys(refundedOnRows[0]) : [];
    refundedOnCols.so = io.fuzzyMatchColumn(cols, ["sales order", "sales order number"]);
    // "Ship date" in this tab is NOT reliable as the refund date — verified
    // against real data (see refund_cancel_dispatch_check_spec.md's original
    // assumption) it consistently runs ~1 day earlier than "Created date and
    // time" in the same row, which is when this refund-fee line was actually
    // logged in D365 and is the date ops confirmed as correct.
    refundedOnCols.date = io.fuzzyMatchColumn(cols, ["created date and time", "created date", "ship date"]);
  }
  const actionsRaw = actionsSheet ? io.sheetToRawRows(wb, actionsSheet, null) : null;

  // Tier 4 fallback: the flat "Workings" sheet's "R_Shipped Date" column —
  // covers orders (e.g. "Ops - to cancel Order" / replacement-flow remarks)
  // that the Refund Date tab and Actions-tab pivots (tiers 1-3) don't.
  const workingsSheet = sheets.find((s) => taskC.normText(s) === "workings") || null;
  let workingsRows = [];
  let workingsCols = { so: null, date: null };
  if (workingsSheet) {
    const preview = io.sheetToRawRows(wb, workingsSheet, 20);
    const g = io.guessHeaderRowAndScore(preview, { so_number: ["sales order"], date: ["r_shipped date"] });
    workingsRows = io.loadTableFromRawRows(io.sheetToRawRows(wb, workingsSheet, null), g.row);
    const cols = workingsRows.length ? Object.keys(workingsRows[0]) : [];
    workingsCols.so = io.fuzzyMatchColumn(cols, ["sales order", "sales order number"]);
    workingsCols.date = io.fuzzyMatchColumn(cols, ["r_shipped date", "replacement shipped date", "shipped date"]);
  }

  container.appendChild(
    h("p", {
      class: "caption",
      text: `Sheets found: Refunded-on tab = ${refundedOnSheet || "NOT FOUND"}, Actions tab = ${actionsSheet || "NOT FOUND"}, Workings tab = ${workingsSheet || "NOT FOUND"}.`,
    })
  );
  if (!refundedOnSheet) {
    container.appendChild(h("p", { class: "warning", text: "No 'Refunded on'-style tab found — tier-1 refund-date resolution will be skipped." }));
  } else if (!refundedOnCols.so || !refundedOnCols.date) {
    container.appendChild(h("p", { class: "error", text: "Could not detect Sales order / Created-date columns in the Refunded-on tab." }));
  }
  if (!actionsSheet) {
    container.appendChild(h("p", { class: "warning", text: "No 'Action(s)'-style tab found — tier-2/3 refund-date resolution will be skipped." }));
  }
  if (!workingsSheet) {
    container.appendChild(h("p", { class: "warning", text: "No 'Workings' tab found — tier-4 refund-date resolution (e.g. 'Ops - to cancel Order') will be skipped." }));
  } else if (!workingsCols.so || !workingsCols.date) {
    container.appendChild(h("p", { class: "error", text: "Could not detect Sales order / R_Shipped Date columns in the Workings tab." }));
  }

  taskCState.openso = { refundedOnRows, refundedOnCols, actionsRaw, workingsRows, workingsCols };
  renderTaskC();
}

async function handleTaskCBatch(file) {
  const container = document.getElementById("task-c-batch-info");
  container.innerHTML = "";
  if (!file) {
    taskCState.batch = null;
    renderTaskC();
    return;
  }
  const state = await setupFileUI(container, file, TASK_C_BATCH_CANDIDATES, null);
  state.onChange = () => renderTaskC();
  taskCState.batch = state;
  renderTaskC();
}

async function handleTaskCOnhand(file) {
  const container = document.getElementById("task-c-onhand-info");
  container.innerHTML = "";
  if (!file) {
    taskCState.onhand = null;
    renderTaskC();
    return;
  }
  const state = await setupFileUI(container, file, TASK_C_ONHAND_CANDIDATES, null);
  state.onChange = () => renderTaskC();
  taskCState.onhand = state;
  renderTaskC();
}

async function handleTaskCAging(file) {
  const container = document.getElementById("task-c-aging-info");
  container.innerHTML = "";
  if (!file) {
    taskCState.aging = null;
    renderTaskC();
    return;
  }
  const state = await setupFileUI(container, file, TASK_C_AGING_CANDIDATES, null);
  state.onChange = () => renderTaskC();
  taskCState.aging = state;
  renderTaskC();
}

async function handleTaskCFulfillmentFiles(files) {
  const container = document.getElementById("task-c-ful-info");
  container.innerHTML = "";
  taskCState.fulfillmentFiles = [];
  if (!files.length) {
    renderTaskC();
    return;
  }
  const multiple = files.length > 1;
  for (const file of files) {
    const fileBox = h("div", { class: multiple ? "file-box" : "" });
    if (multiple) fileBox.appendChild(h("h4", { text: `📄 ${file.name}` }));
    container.appendChild(fileBox);

    const fileState = await setupFileUI(fileBox, file, TASK_B_FULFILLMENT_CANDIDATES, ["item"]);
    const orderLevelInfo = h("p", { class: "info" });
    fileBox.appendChild(orderLevelInfo);
    const errorBox = h("p", { class: "error" });
    fileBox.appendChild(errorBox);

    const known = taskCKnownWarehouses();
    const guessedWh = io.guessWarehouseFromFilename(file.name, known);
    const state = fileState;
    state.name = file.name;
    state.errorBox = errorBox;
    state.assignedWarehouse = guessedWh || "All warehouses";
    state.onChange = () => {
      orderLevelInfo.textContent =
        state.colMap.item == null
          ? "No SKU column found — order-level shipping summary. Matching at the whole-order level."
          : "";
      renderTaskC();
    };
    state.onChange();

    if (multiple) {
      const select = h("select", {});
      select.appendChild(h("option", { value: "All warehouses" }, ["All warehouses"]));
      known.forEach((wh) => select.appendChild(h("option", { value: wh }, [wh])));
      select.value = state.assignedWarehouse;
      fileBox.appendChild(h("label", { text: "Which warehouse is this report for? " }, [select]));
      select.addEventListener("change", () => {
        state.assignedWarehouse = select.value;
        renderTaskC();
      });
    } else if (guessedWh) {
      fileBox.appendChild(h("p", { class: "caption", text: `Applies to: ${state.assignedWarehouse} (detected from filename)` }));
    }

    taskCState.fulfillmentFiles.push(state);
  }
  renderTaskC();
}

function renderTaskC() {
  const root = document.getElementById("task-c-results");
  root.innerHTML = "";
  const { openso, batch, fulfillmentFiles, onhand, aging } = taskCState;

  if (!batch || !onhand || !fulfillmentFiles.length) {
    ops2SyncRun("tab-c", false, (!batch ? 1 : 0) + (!onhand ? 1 : 0) + (!fulfillmentFiles.length ? 1 : 0));
    return;
  }
  if (batch.getMissing().length || onhand.getMissing().length) { ops2SyncRun("tab-c", false, 0); return; }
  if (aging && aging.getMissing().length) { ops2SyncRun("tab-c", false, 0); return; }
  ops2SyncRun("tab-c", true, 0);

  if (!openso) {
    root.appendChild(h("p", { class: "warning", text: "No Open SO workbook uploaded — refund dates cannot be resolved (all Not-Dispatched orders will show as unresolved). Upload it for the full 3-tier refund-date lookup." }));
  }

  // 1. SER-line warehouse backfill.
  const whCol = batch.colMap.warehouse;
  const { rows: backfilled, flagged } = taskC.backfillSerWarehouses(batch.rows, batch.colMap.so_number || batch.colMap.shopify_ref, whCol);
  const flaggedOrders = new Set(flagged.map((f) => f.salesOrder));
  const matchable = backfilled.filter((r) => !flaggedOrders.has(r[batch.colMap.so_number || batch.colMap.shopify_ref]));

  const flagBox = h("details", {});
  flagBox.appendChild(h("summary", { text: `Warehouse backfill: ${flagged.length} order(s) could not be resolved to a single real warehouse` }));
  if (flagged.length) {
    const list = h("div", { class: "diagnostics" });
    list.textContent = flagged.slice(0, 50).map((f) => `${f.salesOrder}: ${f.issue}${f.warehouses.length ? " (" + f.warehouses.join(", ") + ")" : ""}`).join("\n");
    flagBox.appendChild(list);
    if (flagged.length > 50) flagBox.appendChild(h("p", { class: "muted", text: `...and ${flagged.length - 50} more` }));
  }
  root.appendChild(flagBox);

  // 2. Bundle-SKU cost composition (optional, parsed each render).
  const bundleTextarea = document.getElementById("c-bundle-json");
  const bundleInfo = document.getElementById("task-c-bundle-info");
  bundleInfo.innerHTML = "";
  let bundleCompositions = {};
  if (bundleTextarea.value.trim()) {
    try {
      bundleCompositions = JSON.parse(bundleTextarea.value);
    } catch (e) {
      bundleInfo.appendChild(h("p", { class: "error", text: `Invalid JSON: ${e.message}` }));
    }
  }
  if (!bundleTextarea.dataset.wired) {
    bundleTextarea.addEventListener("change", () => renderTaskC());
    bundleTextarea.dataset.wired = "1";
  }

  // 3. Refund-date resolver.
  const resolveRefundDate = openso
    ? taskC.buildRefundDateResolver(
        openso.refundedOnRows, { so: openso.refundedOnCols.so, date: openso.refundedOnCols.date }, openso.actionsRaw,
        openso.workingsRows, openso.workingsCols
      )
    : () => ({ date: null, tier: 5, resolved: false });

  // 4. Validate fulfillment-file warehouse assignments (same rules as Task B).
  const parsed = fulfillmentFiles.filter((f) => f.rows && !f.getMissing().length);
  if (!parsed.length) {
    root.appendChild(h("p", { class: "warning", text: "No fulfillment report could be parsed — check the column mappings above." }));
    return;
  }
  const multiple = fulfillmentFiles.length > 1;
  if (multiple) {
    const assigned = parsed.map((f) => f.assignedWarehouse);
    if (assigned.includes("All warehouses")) {
      root.appendChild(h("p", { class: "error", text: "When uploading multiple fulfillment reports, each must be assigned to a specific warehouse (not 'All warehouses')." }));
      return;
    }
    const dupes = assigned.filter((wh, i) => assigned.indexOf(wh) !== i);
    if (dupes.length) {
      root.appendChild(h("p", { class: "error", text: `More than one report is assigned to: ${Array.from(new Set(dupes)).join(", ")}. Each warehouse needs exactly one report.` }));
      return;
    }
  }

  const cols = {
    item: batch.colMap.item, warehouse: whCol, qty: batch.colMap.qty,
    salesOrder: batch.colMap.so_number, shopifyRef: batch.colMap.shopify_ref, productName: batch.colMap.product_name,
  };
  if (!cols.salesOrder && !cols.shopifyRef) {
    root.appendChild(h("p", { class: "error", text: "The refund/cancel batch file needs a Sales order number or a Shopify reference column to join on." }));
    return;
  }

  const known = Array.from(new Set(matchable.map((r) => String(r[whCol])))).sort();
  let combinedPerSheet = {};
  const combinedDiagnostics = {};
  const covered = new Set();
  let allOutRows = [];

  for (const f of parsed) {
    const wh = multiple ? f.assignedWarehouse : f.assignedWarehouse || "All warehouses";
    let subset;
    if (wh === "All warehouses") {
      subset = matchable;
    } else {
      subset = matchable.filter((r) => String(r[whCol]) === wh);
      covered.add(wh);
    }
    if (!subset.length) {
      // A fulfillment report was uploaded and assigned to this warehouse, but
      // the batch/refund-cancel export has zero matchable rows for it — say
      // so explicitly, rather than silently producing no output at all,
      // which looks identical to "the report failed to process".
      combinedDiagnostics[f.name] = { note: `No refund/cancel batch rows found for warehouse '${wh}' — nothing to check against this report.` };
      continue;
    }
    const { perSheet, rows, diagnostics } = taskC.computeDispatchCheck(subset, cols, f.rows, f.colMap, resolveRefundDate);
    combinedPerSheet = { ...combinedPerSheet, ...perSheet };
    allOutRows = allOutRows.concat(rows);
    combinedDiagnostics[f.name] = diagnostics;
  }

  if (multiple) {
    const uncovered = known.filter((wh) => !covered.has(wh));
    for (const wh of uncovered) {
      const subset = matchable.filter((r) => String(r[whCol]) === wh);
      if (!subset.length) continue;
      const emptyFulCols = { item: cols.item, shipped_qty: "__shipped_qty", tracking: "__tracking", shipped_date: "__shipped_date" };
      const { perSheet, rows, diagnostics } = taskC.computeDispatchCheck(subset, cols, [], emptyFulCols, resolveRefundDate);
      combinedPerSheet = { ...combinedPerSheet, ...perSheet };
      allOutRows = allOutRows.concat(rows);
      combinedDiagnostics[`(no report uploaded for ${wh})`] = diagnostics;
    }
  }

  const diagBox = h("details", {}, [h("summary", { text: "Summary / diagnostics (per uploaded file)" }), h("pre", { class: "diagnostics" })]);
  diagBox.querySelector("pre").textContent = JSON.stringify(combinedDiagnostics, null, 2);
  root.appendChild(diagBox);

  if (!Object.keys(combinedPerSheet).length) {
    root.appendChild(h("p", { class: "warning", text: "No output rows produced — check the column mappings above." }));
    return;
  }

  // Dispatch-check download buttons, one per warehouse (both its sheets).
  const dispatchArea = h("div", {});
  root.appendChild(h("h3", { text: "Step 4 — Dispatch check" }));
  root.appendChild(
    h("p", {
      class: "file-desc",
      text: "For every refund/cancel order line, confirms whether it actually shipped by matching against the warehouse fulfillment report(s) — this is the working data Steps 5-7 build from, not itself a D365 import file.",
    })
  );
  // Steps 5-7 further below reuse these same two arrays (built once here).
  const dispatchedRows = allOutRows.filter((r) => r.__dispatch_status === "Dispatched");
  const notDispatchedRows = allOutRows.filter((r) => r.__dispatch_status === "Not Dispatched");
  const orderKeyOf = (r) => (r[cols.salesOrder] != null ? r[cols.salesOrder] : r[cols.shopifyRef]);
  const dispatchedOrderCount = new Set(dispatchedRows.map(orderKeyOf)).size;
  const notDispatchedOrderCount = new Set(notDispatchedRows.map(orderKeyOf)).size;
  root.appendChild(
    h("p", { class: "caption" }, [
      `${dispatchedOrderCount + notDispatchedOrderCount} order(s) checked — ${dispatchedOrderCount} `,
      statusChip("Dispatched"),
      ` (${dispatchedRows.length} line(s)), ${notDispatchedOrderCount} `,
      statusChip("Not Dispatched"),
      ` (${notDispatchedRows.length} line(s)).`,
    ])
  );
  root.appendChild(dispatchArea);

  // Separate downloadable file per warehouse + status (Dispatched / Not
  // Dispatched go in their own workbook, never mixed) + month — Dispatched
  // rows split by their actual Shipped-date month, Not Dispatched rows by
  // their resolved Refund-date month, mirroring Step 6's journal splitting.
  const monthKeyForDispatchRow = (row) => {
    const raw =
      row.__dispatch_status === "Dispatched"
        ? row.__shipped_date_raw
        : row.__refund_date_resolution && row.__refund_date_resolution.resolved
        ? row.__refund_date_resolution.date
        : null;
    if (raw == null) return "unknown";
    return taskC.monthKey(raw) || "unknown";
  };
  const dispatchFileGroups = new Map(); // `${wh}|${status}|${monthKey}` -> { wh, status, monthKey, rows }
  for (const row of allOutRows) {
    const wh = row.__warehouse;
    const status = row.__dispatch_status;
    const mk = monthKeyForDispatchRow(row);
    const groupKey = `${wh}|${status}|${mk}`;
    if (!dispatchFileGroups.has(groupKey)) dispatchFileGroups.set(groupKey, { wh, status, monthKey: mk, rows: [] });
    dispatchFileGroups.get(groupKey).rows.push(row);
  }
  const sortedGroups = Array.from(dispatchFileGroups.values()).sort((a, b) => {
    if (a.wh !== b.wh) return a.wh < b.wh ? -1 : 1;
    if (a.status !== b.status) return a.status === "Dispatched" ? -1 : 1;
    return a.monthKey < b.monthKey ? -1 : a.monthKey > b.monthKey ? 1 : 0;
  });
  root.appendChild(
    h("p", {
      class: "file-desc",
      text: "One file per warehouse + status + month, one row per order line — this is the raw dispatch-check detail (which orders matched, tracking/shipped date found or not). Use it to hand off or archive; the overview below lets you preview any of these without downloading.",
    })
  );
  for (const group of sortedGroups) {
    const statusSlug = group.status.replace(/\s+/g, "");
    const row = h("div", { class: "file-row" });
    row.appendChild(statusChip(group.status));
    const btn = h("button", { text: `Download ${group.wh} — ${group.monthKey} (${group.rows.length} rows) (.xlsx)` });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = "Building file...";
      try {
        const buf = await io.toExcelBytes({ [group.status]: group.rows });
        downloadBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${todayStamp()}_${group.wh}_${statusSlug}_${group.monthKey}_Dispatch_Check.xlsx`);
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
    row.appendChild(btn);
    dispatchArea.appendChild(row);
  }
  // A-Z by warehouse (e.g. USOPS-WH04 before USOPS-WH05), Dispatched before
  // Not Dispatched within each warehouse.
  const sortedSheetEntries = Object.entries(combinedPerSheet).sort(([nameA], [nameB]) => {
    const [whA, statusA] = nameA.split(" - ");
    const [whB, statusB] = nameB.split(" - ");
    if (whA !== whB) return whA < whB ? -1 : 1;
    if (statusA !== statusB) return statusA === "Dispatched" ? -1 : 1;
    return 0;
  });
  for (const [name, rows] of sortedSheetEntries) {
    const [wh, status] = name.split(" - ");
    renderCollapsibleTable(root, [`${wh} — `, statusChip(status)], rows, 100);
  }

  // Steps 5-7: build the two remaining artifacts using ALL matched rows
  // (dispatchedRows/notDispatchedRows already built above for the Step 4 summary).
  const batchLookup = taskC.buildBatchLookup(onhand.rows, onhand.colMap);
  const batchLookupFn = (item, wh) => batchLookup.get(`${item}|${wh}`) || "";

  root.appendChild(h("h3", {}, ["Step 5 — D365 fulfillment template ", statusChip("Dispatched")]));
  root.appendChild(
    h("p", {
      class: "file-desc",
      text: "D365's own \"order\" + \"serial number\" import format: one row per unit already shipped, with the batch number D365 needs to record the stock movement. Upload this file to D365 to record these orders as fulfilled.",
    })
  );
  const step5 = taskC.buildFulfillmentTemplateRows(
    dispatchedRows, cols,
    (row) => row["Shipped date"],
    (row, isService) => (isService ? "" : row["Tracking number"] || ""),
    batchLookupFn
  );
  if (step5.multiTrackingOrders.length) {
    root.appendChild(h("p", { class: "warning", text: `${step5.multiTrackingOrders.length} order(s) have multiple tracking numbers — verify manually: ${step5.multiTrackingOrders.slice(0, 20).join(", ")}` }));
  }
  const step5Btn = h("button", { text: `Download D365 fulfillment template — Dispatched (.xlsx)` });
  step5Btn.addEventListener("click", async () => {
    step5Btn.disabled = true;
    try {
      const buf = await io.toExcelBytes({ order: step5.rows, "serial number": { columns: ["Order ID", "SKU Number", "Serial number"], rows: [] } });
      downloadBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${todayStamp()}_D365_Fulfillment_Dispatched.xlsx`);
    } finally {
      step5Btn.disabled = false;
      step5Btn.textContent = "Download D365 fulfillment template — Dispatched (.xlsx)";
    }
  });
  root.appendChild(step5Btn);
  root.appendChild(h("p", { class: "caption", text: `${step5.rows.length} unit-rows across ${dispatchedRows.length} lines.` }));

  root.appendChild(h("h3", {}, ["Step 6 — Inventory adjustment journal ", statusChip("Not Dispatched")]));
  root.appendChild(
    h("p", {
      class: "file-desc",
      text: "For orders that were refunded/cancelled without ever shipping: adds the stock back into on-hand inventory in D365 (one row per SKU, split into one file per warehouse + refund month). Upload this to D365 to correct the inventory count.",
    })
  );
  if (!aging) {
    root.appendChild(h("p", { class: "warning", text: "No aging report uploaded — Cost price/Unit will be blank and every item flagged for manual cost entry." }));
  }
  const costLookupObj = {
    batchLookup: batchLookupFn,
    costLookup: aging
      ? (item, wh) => {
          const c = aging.rows.find((r) => r[aging.colMap.item] === item && r[aging.colMap.warehouse] === wh);
          return c ? { cost: toNum(c[aging.colMap.cost]), unit: aging.colMap.unit ? c[aging.colMap.unit] : null } : null;
        }
      : () => null,
    unitLookup: (item) => {
      const r = onhand.rows.find((row) => row[onhand.colMap.item] === item);
      return r && onhand.colMap.unit ? r[onhand.colMap.unit] : "";
    },
    manufacturerLookup: (item) => {
      const r = onhand.rows.find((row) => row[onhand.colMap.item] === item);
      return r && onhand.colMap.manufacturer ? r[onhand.colMap.manufacturer] : "";
    },
  };
  const journal = taskC.computeInventoryJournal(notDispatchedRows, cols, costLookupObj, bundleCompositions, new Date());
  if (journal.unresolvedCosts.length) {
    root.appendChild(h("p", { class: "warning", text: `${journal.unresolvedCosts.length} item/warehouse combination(s) have no aging-report cost and no bundle composition — Cost price/amount left blank in the same file, flagged for manual entry.` }));
  }
  if (journal.unresolvedBundles.length) {
    root.appendChild(h("p", { class: "warning", text: `${journal.unresolvedBundles.length} bundle SKU(s) had an incomplete cost composition — Cost price/amount left blank.` }));
  }
  // A-Z by warehouse (USOPS-WH04 before USOPS-WH05), then by month.
  const sortedJournalFiles = journal.files.slice().sort((a, b) => {
    if (a.warehouse !== b.warehouse) return a.warehouse < b.warehouse ? -1 : 1;
    return a.monthKey < b.monthKey ? -1 : a.monthKey > b.monthKey ? 1 : 0;
  });
  for (const file of sortedJournalFiles) {
    if (file.isPastMonthDefaulted) {
      root.appendChild(h("p", { class: "warning", text: `${file.warehouse} (${file.monthKey}): past-month journal — date defaulted to the latest refund date in the group (${file.dateUsed}). Confirm with ops before using.` }));
    }
    const btn = h("button", { text: `Download ${file.warehouse} journal — ${file.monthKey} (.xlsx)` });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const buf = await io.toExcelBytes({ journal: file.table });
        downloadBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${todayStamp()}_${file.warehouse}_Inventory_Adjustment_${file.monthKey}.xlsx`);
      } finally {
        btn.disabled = false;
        btn.textContent = `Download ${file.warehouse} journal — ${file.monthKey} (.xlsx)`;
      }
    });
    root.appendChild(btn);
    renderCollapsibleTable(root, `${file.warehouse} journal — ${file.monthKey}`, file.table, 200);
  }

  root.appendChild(h("h3", {}, ["Step 7 — D365 fulfillment template ", statusChip("Not Dispatched")]));
  root.appendChild(
    h("p", {
      class: "file-desc",
      text: "Same D365 \"order\"/\"serial number\" import format as Step 5, but for orders that never shipped — marks each FG line's AWB as \"Cancel order\" (SER lines blank) instead of a real tracking number. Upload this to D365 to close out these order lines.",
    })
  );
  const step7 = taskC.buildFulfillmentTemplateRows(
    notDispatchedRows, cols,
    (row) => row["Refund Date"],
    (row, isService) => (isService ? "" : "Cancel order"),
    batchLookupFn // same on-hand-derived lookup Step 6 used — guarantees consistency, not re-derived.
  );
  const step7Btn = h("button", { text: `Download D365 fulfillment template — Not Dispatched (.xlsx)` });
  step7Btn.addEventListener("click", async () => {
    step7Btn.disabled = true;
    try {
      const buf = await io.toExcelBytes({ order: step7.rows, "serial number": { columns: ["Order ID", "SKU Number", "Serial number"], rows: [] } });
      downloadBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${todayStamp()}_D365_Fulfillment_NotDispatched.xlsx`);
    } finally {
      step7Btn.disabled = false;
      step7Btn.textContent = "Download D365 fulfillment template — Not Dispatched (.xlsx)";
    }
  });
  root.appendChild(step7Btn);
  root.appendChild(h("p", { class: "caption", text: `${step7.rows.length} unit-rows across ${notDispatchedRows.length} lines.` }));
}

// ---------------- Task D ----------------

const TASK_D_WAREHOUSES = KNOWN_WAREHOUSES;
const TASK_D_REPORT_CANDIDATES = { item: ["item number", "sku", "item", "item code", "product code"], product_name: ["product name", "name", "description", "item name"] };
// Different warehouses/3PLs hand over damage reports in different shapes — a
// single "Quantity" column is at least as common as the spec's multi-period-
// column layout, so both are auto-detected and whichever is unambiguous wins.
const TASK_D_QTY_CANDIDATES = ["quantity", "qty", "damaged qty", "qty damaged", "damage qty", "damaged quantity", "defective qty", "disposal qty", "disposed qty"];
const TASK_D_DATE_CANDIDATES = ["date", "damage date", "defect date", "disposal date", "period", "date range", "period covered"];

const taskDState = { report: null, onhand: null, aging: null, warehouse: TASK_D_WAREHOUSES[0], adjustmentDate: null, reasonCode: "DMG", reasonDescription: "Physical damage", aggregateBySku: false };

function taskDRowClass(row, idx, rowColors) {
  const c = rowColors[idx];
  return c ? `row-${c}` : null;
}

async function handleTaskDReport(file) {
  const container = document.getElementById("task-d-report-info");
  container.innerHTML = "";
  if (!file) {
    taskDState.report = null;
    renderTaskD();
    return;
  }

  const source = await loadWorkbookOrCsv(file);
  const best = guessSheetAndHeader(source, TASK_D_REPORT_CANDIDATES);
  let sheetName = best.sheet;
  let headerRow = best.row;

  const caption = h("p", { class: "caption" });
  const details = h("details", {});
  const summary = h("summary", {});
  details.appendChild(summary);
  const overrideBox = h("div", {});
  details.appendChild(overrideBox);
  const colGrid = h("div", { class: "col-grid" });
  details.appendChild(colGrid);
  const periodBox = h("div", {});
  const errorBox = h("p", { class: "error" });

  const warehouseGuess = io.guessWarehouseFromFilename(file.name, TASK_D_WAREHOUSES);
  if (warehouseGuess) taskDState.warehouse = warehouseGuess;

  const state = { rawRows: null, headerRow: 0, itemColIndex: null, productColIndex: null, periodColIndex: null, fileName: file.name, onChange: null };
  taskDState.report = state;

  function getRawRows() {
    return source.kind === "xlsx" ? io.sheetToRawRows(source.wb, sheetName, null) : source.raw;
  }

  // A few real data rows, shown next to each column option so the user can
  // pick the right one by looking at actual values — headers alone aren't
  // reliable since different warehouses/3PLs format them differently.
  function samplePreviewRows(rawRows) {
    return rawRows.slice(headerRow + 1).filter((r) => r && r.some((v) => v != null && String(v).trim() !== "")).slice(0, 3);
  }

  function columnOptionLabel(headerVals, i, samples, tag) {
    const hv = headerVals[i];
    const sampleVals = samples.map((r) => r[i]).filter((v) => v != null && String(v).trim() !== "").slice(0, 3);
    const sampleText = sampleVals.length ? ` — e.g. ${sampleVals.join(", ")}` : "";
    return `${taskD.colLetter(i + 1)}: ${hv || "(blank)"}${tag || ""}${sampleText}`;
  }

  function rebuildPeriodBox(headerVals, rawRows, qtyGuessIndex, dateGuessName) {
    periodBox.innerHTML = "";
    const samples = samplePreviewRows(rawRows);
    const periodCols = taskD.findPeriodQuantityColumns(headerVals);

    // Combine both detection strategies: a fuzzy-named single Quantity column
    // (most common shape) and the spec's date-range-per-column layout. Only
    // auto-pick when there's exactly one plausible candidate across both —
    // never guess when more than one column looks plausible.
    const candidateIndexes = new Set();
    if (qtyGuessIndex != null) candidateIndexes.add(qtyGuessIndex);
    periodCols.forEach((p) => candidateIndexes.add(p.colIndex));

    if (dateGuessName) {
      const dateIdx = headerVals.indexOf(dateGuessName);
      const dateSamples = samples.map((r) => r[dateIdx]).filter((v) => v != null);
      periodBox.appendChild(h("p", { class: "info", text: `Detected a date column '${dateGuessName}' — sample values: ${dateSamples.slice(0, 3).join(", ") || "(none)"}. This does not set the adjustment date automatically — set that below once results appear.` }));
    }

    periodBox.appendChild(h("p", { class: "caption", text: "Which column holds the disposal quantity for this run? Real sample values are shown next to each column so you can pick correctly even if the header format is unusual." }));
    if (!candidateIndexes.size) {
      periodBox.appendChild(h("p", { class: "warning", text: "No quantity column auto-detected — pick it manually below using the sample values shown." }));
    } else if (candidateIndexes.size > 1) {
      periodBox.appendChild(h("p", { class: "warning", text: "Multiple possible quantity columns found (marked ★ below) — pick the correct one; never guessed automatically when ambiguous." }));
    }

    const select = h("select", {});
    select.appendChild(h("option", { value: "" }, ["-- pick a column --"]));
    const headerCounts = {};
    headerVals.forEach((hv) => { headerCounts[hv] = (headerCounts[hv] || 0) + 1; });
    headerVals.forEach((hv, i) => {
      const dupTag = hv && headerCounts[hv] > 1 ? " [duplicate header]" : "";
      const recTag = candidateIndexes.has(i) ? " ★ likely quantity column" : "";
      select.appendChild(h("option", { value: String(i) }, [columnOptionLabel(headerVals, i, samples, `${dupTag}${recTag}`)]));
    });
    if (state.periodColIndex == null && candidateIndexes.size === 1) {
      state.periodColIndex = Array.from(candidateIndexes)[0];
    }
    select.value = state.periodColIndex == null ? "" : String(state.periodColIndex);
    select.addEventListener("change", () => {
      state.periodColIndex = select.value === "" ? null : parseInt(select.value, 10);
      periodConfirm.textContent = state.periodColIndex != null ? `Using column ${taskD.colLetter(state.periodColIndex + 1)}: "${headerVals[state.periodColIndex] || "(blank)"}".` : "";
      if (state.onChange) state.onChange();
    });
    periodBox.appendChild(select);
    const periodConfirm = h("p", { class: "info" });
    periodConfirm.textContent = state.periodColIndex != null ? `Using column ${taskD.colLetter(state.periodColIndex + 1)}: "${headerVals[state.periodColIndex] || "(blank)"}".` : "";
    periodBox.appendChild(periodConfirm);
  }

  function refreshAndNotify() {
    errorBox.textContent = state.itemColIndex == null ? "Missing required column: Item number / SKU — pick it manually above." : "";
    if (state.itemColIndex == null) details.open = true;
    if (state.onChange) state.onChange();
  }

  function rebuild() {
    const rawRows = getRawRows();
    state.rawRows = rawRows;
    state.headerRow = headerRow;
    const headerVals = (rawRows[headerRow] || []).map((v) => (v == null ? "" : String(v).trim()));
    const uniqueHeaders = Array.from(new Set(headerVals.filter(Boolean)));

    const itemGuessName = io.fuzzyMatchColumn(uniqueHeaders, TASK_D_REPORT_CANDIDATES.item);
    const productGuessName = io.fuzzyMatchColumn(uniqueHeaders, TASK_D_REPORT_CANDIDATES.product_name);
    const qtyGuessName = io.fuzzyMatchColumn(uniqueHeaders, TASK_D_QTY_CANDIDATES);
    const dateGuessName = io.fuzzyMatchColumn(uniqueHeaders, TASK_D_DATE_CANDIDATES);
    if (state.itemColIndex == null) state.itemColIndex = itemGuessName ? headerVals.indexOf(itemGuessName) : null;
    if (state.productColIndex == null) state.productColIndex = productGuessName ? headerVals.indexOf(productGuessName) : null;
    const qtyGuessIndex = qtyGuessName ? headerVals.indexOf(qtyGuessName) : null;

    caption.textContent = `Loaded ${Math.max(rawRows.length - headerRow - 1, 0)} data row(s) from '${sheetName || "(csv)"}', header row ${headerRow}. Detected: Item number/SKU → '${itemGuessName || "NOT FOUND"}', Product name → '${productGuessName || "(none)"}'.`;
    summary.textContent = "Fix detected columns / sheet / header row";

    colGrid.innerHTML = "";
    const samples = samplePreviewRows(rawRows);
    const colOptions = headerVals.map((hv, i) => ({ label: columnOptionLabel(headerVals, i, samples), index: i }));
    function buildColSelect(label, currentIndex, onPick, allowNone) {
      const wrap = h("div", { class: "col-field" });
      wrap.appendChild(h("label", { text: label }));
      const select = h("select", {});
      if (allowNone) select.appendChild(h("option", { value: "" }, ["-- none --"]));
      colOptions.forEach((c) => select.appendChild(h("option", { value: String(c.index) }, [c.label])));
      select.value = currentIndex == null ? "" : String(currentIndex);
      select.addEventListener("change", () => {
        onPick(select.value === "" ? null : parseInt(select.value, 10));
        refreshAndNotify();
      });
      wrap.appendChild(select);
      return wrap;
    }
    colGrid.appendChild(buildColSelect("Item number / SKU", state.itemColIndex, (v) => { state.itemColIndex = v; }, false));
    colGrid.appendChild(buildColSelect("Product name (optional)", state.productColIndex, (v) => { state.productColIndex = v; }, true));

    rebuildPeriodBox(headerVals, rawRows, qtyGuessIndex, dateGuessName);
    refreshAndNotify();
  }

  overrideBox.innerHTML = "";
  if (source.sheets && source.sheets.length > 1) {
    const sheetSelect = h("select", {});
    source.sheets.forEach((s) => sheetSelect.appendChild(h("option", { value: s }, [s])));
    sheetSelect.value = sheetName;
    sheetSelect.addEventListener("change", () => { sheetName = sheetSelect.value; rebuild(); });
    overrideBox.appendChild(h("label", { text: "Sheet: " }, [sheetSelect]));
  }
  const headerInput = h("input", { type: "number", min: "0", max: "19" });
  headerInput.value = String(headerRow);
  headerInput.addEventListener("change", () => { headerRow = parseInt(headerInput.value, 10) || 0; rebuild(); });
  overrideBox.appendChild(h("label", { text: " Header row (0 = first row): " }, [headerInput]));

  container.appendChild(caption);
  container.appendChild(details);
  container.appendChild(periodBox);
  container.appendChild(errorBox);

  rebuild();
  state.onChange = () => renderTaskD();
  renderTaskD();
}

async function handleTaskDOnhand(file) {
  const container = document.getElementById("task-d-onhand-info");
  container.innerHTML = "";
  if (!file) {
    taskDState.onhand = null;
    renderTaskD();
    return;
  }
  const state = await setupFileUI(container, file, TASK_C_ONHAND_CANDIDATES, null);
  state.onChange = () => renderTaskD();
  taskDState.onhand = state;
  renderTaskD();
}

async function handleTaskDAging(file) {
  const container = document.getElementById("task-d-aging-info");
  container.innerHTML = "";
  if (!file) {
    taskDState.aging = null;
    renderTaskD();
    return;
  }
  const state = await setupFileUI(container, file, TASK_C_AGING_CANDIDATES, null);
  state.onChange = () => renderTaskD();
  taskDState.aging = state;
  renderTaskD();
}

function stripReviewColumns(table) {
  return table.map((row) => {
    const clean = { ...row };
    delete clean["Source section"];
    delete clean.Flag;
    return clean;
  });
}

function renderTaskD() {
  const root = document.getElementById("task-d-results");
  root.innerHTML = "";
  const { report, onhand, aging } = taskDState;
  if (!report || !report.rawRows) {
    ops2SyncRun("tab-d", false, 1);
    return;
  }
  if (report.itemColIndex == null) { ops2SyncRun("tab-d", false, 0); return; }
  if (report.periodColIndex == null) {
    ops2SyncRun("tab-d", false, 0);
    root.appendChild(h("p", { class: "warning", text: "Pick the period/quantity column above to continue." }));
    return;
  }
  if (onhand && onhand.getMissing().length) { ops2SyncRun("tab-d", false, 0); return; }
  if (aging && aging.getMissing().length) { ops2SyncRun("tab-d", false, 0); return; }
  ops2SyncRun("tab-d", true, 0);

  if (!onhand) root.appendChild(h("p", { class: "warning", text: "No on-hand snapshot uploaded — Batch number will be left blank and flagged for manual entry on every line." }));
  if (!aging) root.appendChild(h("p", { class: "warning", text: "No aging report uploaded — Cost price will be left at 0 and flagged for manual entry on every line." }));

  const paramsBox = h("div", { class: "col-grid" });
  const whWrap = h("div", { class: "col-field" });
  whWrap.appendChild(h("label", { text: "Warehouse" }));
  const whSelect = h("select", {});
  TASK_D_WAREHOUSES.forEach((w) => whSelect.appendChild(h("option", { value: w }, [w])));
  whSelect.value = taskDState.warehouse;
  whSelect.addEventListener("change", () => { taskDState.warehouse = whSelect.value; recompute(); });
  whWrap.appendChild(whSelect);
  paramsBox.appendChild(whWrap);

  const dateWrap = h("div", { class: "col-field" });
  dateWrap.appendChild(h("label", { text: "Adjustment date" }));
  const dateInput = h("input", { type: "date" });
  if (taskDState.adjustmentDate) dateInput.value = taskDState.adjustmentDate;
  dateInput.addEventListener("change", () => { taskDState.adjustmentDate = dateInput.value; recompute(); });
  dateWrap.appendChild(dateInput);
  paramsBox.appendChild(dateWrap);

  const codeWrap = h("div", { class: "col-field" });
  codeWrap.appendChild(h("label", { text: "Disposal reason code" }));
  const codeInput = h("input", { type: "text" });
  codeInput.value = taskDState.reasonCode;
  codeInput.addEventListener("change", () => { taskDState.reasonCode = codeInput.value; recompute(); });
  codeWrap.appendChild(codeInput);
  paramsBox.appendChild(codeWrap);

  const descWrap = h("div", { class: "col-field" });
  descWrap.appendChild(h("label", { text: "Disposal reason description" }));
  const descInput = h("input", { type: "text" });
  descInput.value = taskDState.reasonDescription;
  descInput.addEventListener("change", () => { taskDState.reasonDescription = descInput.value; recompute(); });
  descWrap.appendChild(descInput);
  paramsBox.appendChild(descWrap);

  root.appendChild(paramsBox);

  const aggWrap = h("label", { class: "checkbox-inline" });
  const aggCb = h("input", { type: "checkbox" });
  aggCb.checked = taskDState.aggregateBySku;
  aggCb.addEventListener("change", () => { taskDState.aggregateBySku = aggCb.checked; recompute(); });
  aggWrap.appendChild(aggCb);
  aggWrap.appendChild(document.createTextNode(" Combine multiple lines for the same SKU into one adjustment line (summed quantity, one batch allocation)"));
  root.appendChild(aggWrap);

  const entityLine = h("p", { class: "info" });
  root.appendChild(entityLine);
  const diagBox = h("details", {}, [h("summary", { text: "Validation / diagnostics" }), h("pre", { class: "diagnostics" })]);
  root.appendChild(diagBox);
  const btnArea = h("div", {});
  root.appendChild(btnArea);
  const tblContainer = h("div", {});
  root.appendChild(tblContainer);

  function recompute() {
    if (!taskDState.adjustmentDate) {
      entityLine.textContent = "Pick an adjustment date above to generate the journal.";
      diagBox.querySelector(".diagnostics").textContent = "";
      btnArea.innerHTML = "";
      tblContainer.innerHTML = "";
      return;
    }
    const onHandIndex = onhand ? taskD.buildOnHandIndex(onhand.rows, onhand.colMap) : null;
    const costLookup = aging ? taskD.buildAgingCostLookup(aging.rows, aging.colMap) : null;

    const result = taskD.computeDisposalJournal({
      rawRows: report.rawRows,
      headerRow: report.headerRow,
      itemColIndex: report.itemColIndex,
      productColIndex: report.productColIndex,
      periodColIndex: report.periodColIndex,
      warehouse: taskDState.warehouse,
      adjustmentDate: taskDState.adjustmentDate,
      reasonCode: taskDState.reasonCode,
      reasonDescription: taskDState.reasonDescription,
      onHandIndex,
      costLookup,
      sourceLabel: `${report.fileName} — ${report.rawRows[report.headerRow][report.periodColIndex]}`,
      aggregateBySku: taskDState.aggregateBySku,
    });

    const aggNote = result.diagnostics.aggregatedBySku
      ? ` (combined into ${result.diagnostics.skuGroupsProduced} SKU line(s) before batch allocation)`
      : "";
    entityLine.textContent = `Entity: ${result.diagnostics.entity} (derived from warehouse ${taskDState.warehouse}). Row count: ${result.diagnostics.rawRowCount} data rows read, ${result.diagnostics.rowsConsidered} with non-zero quantity in the selected period${aggNote}, ${result.diagnostics.rowsProduced} journal line(s) produced.`;
    diagBox.querySelector(".diagnostics").textContent = JSON.stringify(result.diagnostics, null, 2);

    btnArea.innerHTML = "";
    if (!result.table.length) {
      btnArea.appendChild(h("p", { class: "warning", text: "No journal lines produced — check the period column and item detection above." }));
      tblContainer.innerHTML = "";
      return;
    }

    const reviewBtn = h("button", { text: "Download review copy (.xlsx, 22 cols incl. Source/Flag)" });
    reviewBtn.addEventListener("click", async () => {
      reviewBtn.disabled = true;
      reviewBtn.textContent = "Building file...";
      try {
        const buf = await io.toExcelBytes({ "Disposal Journal": result.table }, { "Disposal Journal": result.rowColors });
        downloadBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${todayStamp()}_${taskDState.warehouse}_Disposal_Journal_Review.xlsx`);
      } finally {
        reviewBtn.disabled = false;
        reviewBtn.textContent = "Download review copy (.xlsx, 22 cols incl. Source/Flag)";
      }
    });
    btnArea.appendChild(reviewBtn);

    const importBtn = h("button", { text: "Download D365 import file (.xlsx, 20 cols)" });
    importBtn.addEventListener("click", async () => {
      importBtn.disabled = true;
      importBtn.textContent = "Building file...";
      try {
        const stripped = stripReviewColumns(result.table);
        const buf = await io.toExcelBytes({ "Disposal Journal": stripped }, { "Disposal Journal": result.rowColors });
        downloadBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${todayStamp()}_${taskDState.warehouse}_Disposal_Journal_D365.xlsx`);
      } finally {
        importBtn.disabled = false;
        importBtn.textContent = "Download D365 import file (.xlsx, 20 cols)";
      }
    });
    btnArea.appendChild(importBtn);

    tblContainer.innerHTML = "";
    renderTable(result.table, tblContainer, 200, (row, idx) => taskDRowClass(row, idx, result.rowColors));
  }

  recompute();
}

// ---------------- Task E ----------------

// Facts explicitly documented in TikTok_to_D365_SO_Workflow.md. Everything
// else (exact column-letter roles, row numbers) is NOT prefilled — the doc
// is explicit that layout varies by region and drifts month to month, so
// guessing specific columns without evidence would be worse than an empty
// field the user fills in after looking at the raw preview below.
const TASK_E_REGION_INFO = {
  "HK/Global": {
    warehouse: "USOPS-WH07", location: "Primary", sheetHint: "for ops",
    caption: "Doc reference: sheet \"SKU [Month] - for Ops\" — sales table in cols K:Q, fee table in cols A:D. Item codes for the same fee type can change between months (e.g. FBT fulfillment fee was IM8-SER-000003 in June) — always use this file's own mapping, never a prior month's.",
  },
  US: {
    warehouse: "USOPS-WH07", location: "Primary", sheetHint: "summary",
    caption: "Doc reference: sheet \"Summary\" — item table A23:D45, fee table D3:L13 (fee names on row 11, item codes on row 12 — the dollar-amount row isn't fixed, confirm it yourself). July's FBT fulfillment fee = IM8-SER-000023.",
  },
  UK: {
    warehouse: "OPS-WH04", location: "Primary", sheetHint: "summary (ops)",
    caption: "Doc reference: sheet \"Summary (Ops)\" — fully self-contained with its own item-number mapping and an explicit \"Total SO Amount for [Month]\" cell. No fixed ranges documented — inspect the raw preview below. July's FBT fulfillment fee + FBT free-shipping fee both map to IM8-SER-000023.",
  },
};

const taskEState = {
  wb: null, sheets: [],
  region: "HK/Global",
  itemSheet: null, itemRange: "", itemCols: { sku: "", productName: "", unitPrice: "", discount: "", qty: "" },
  feeSheet: null, feeMode: "rowwise",
  feeRange: "", feeCols: { feeType: "", itemCode: "", amount: "" },
  feeTransposed: { startCol: "", endCol: "", feeTypeRow: "", itemCodeRow: "", amountRow: "" },
  referenceTotal: "",
  bundleCompositions: {},
  auto: null, // set by tryAutoDetectTaskE() — result of taskE.autoDetectUsSummaryTable, or null
};

function taskERawRows(sheetName) {
  if (!taskEState.wb || !sheetName) return [];
  return io.sheetToRawRows(taskEState.wb, sheetName, null);
}

function parseTaskERowRange(rangeStr) {
  const m = /^([A-Za-z]+)\s*(\d+)\s*:\s*([A-Za-z]+)\s*(\d+)$/.exec(String(rangeStr || "").trim());
  if (!m) throw new Error('expected a range like "A23:D45"');
  return { startRow: parseInt(m[2], 10), endRow: parseInt(m[4], 10) };
}

function renderRawGridPreview(container, rawRows, maxRows, maxCols) {
  maxRows = maxRows || 50;
  maxCols = maxCols || 26;
  container.innerHTML = "";
  if (!rawRows.length) {
    container.appendChild(h("p", { class: "muted", text: "(empty sheet)" }));
    return;
  }
  const table = h("table", { class: "data-table" });
  const headRow = h("tr");
  headRow.appendChild(h("th", { text: "#" }));
  for (let c = 0; c < maxCols; c++) headRow.appendChild(h("th", { text: taskE.colLetterFromIndex(c) }));
  table.appendChild(headRow);
  for (let r = 0; r < Math.min(maxRows, rawRows.length); r++) {
    const tr = h("tr");
    tr.appendChild(h("td", { text: String(r + 1) }));
    const row = rawRows[r] || [];
    for (let c = 0; c < maxCols; c++) {
      const v = row[c];
      tr.appendChild(h("td", { text: v == null ? "" : String(v) }));
    }
    table.appendChild(tr);
  }
  container.appendChild(h("div", { class: "data-table-wrap" }, [table]));
  if (rawRows.length > maxRows) {
    container.appendChild(h("p", { class: "muted", text: `... and ${rawRows.length - maxRows} more rows (only the first ${maxRows} are shown in this preview — the row numbers above still match the real sheet).` }));
  }
}

// Attempts auto-detection for the currently-selected region against the
// already-loaded workbook. Only wired up for US so far (verified against a
// real file) — other regions always fall through to the manual sheet/
// range/column configuration form below, unchanged.
// Sets the region dropdown/segmented control without re-triggering their
// own change handlers (which would re-run detection and could recurse).
function setTaskERegionUi(region) {
  const select = document.getElementById("e-region");
  if (select) select.value = region;
  document.querySelectorAll("#e-region-seg button").forEach((b) => {
    b.classList.toggle("ops2-seg-active", b.dataset.region === region);
  });
}

// Called right after a fresh file upload: tries every sheet in the
// workbook (starting with whichever the currently-selected region's own
// hint already guessed) against the US auto-detect landmarks, regardless
// of which region happens to be selected — a file's own layout is
// unambiguous, so the user shouldn't have to remember to pick "US" first
// for a file that's clearly this shape. On a match, syncs the region
// control to reflect it (a real region, not left showing a stale default).
function tryAutoDetectTaskE() {
  taskEState.auto = null;
  if (!taskEState.wb) return;
  const candidates = [taskEState.itemSheet, ...taskEState.sheets].filter((s, i, arr) => s && arr.indexOf(s) === i);
  for (const sheetName of candidates) {
    let result = null;
    try {
      result = taskE.autoDetectUsSummaryTable(taskERawRows(sheetName));
    } catch (e) {
      result = null;
    }
    if (result) {
      taskEState.auto = result;
      taskEState.itemSheet = sheetName;
      taskEState.feeSheet = sheetName;
      if (taskEState.region !== "US") {
        taskEState.region = "US";
        setTaskERegionUi("US");
      }
      return;
    }
  }
}

// Called when the user explicitly changes the region dropdown afterwards:
// only re-attempts detection when that explicit choice is US, and never
// flips the region back on its own — an explicit non-US choice (even
// against a file that happens to also match the US shape) is respected,
// not silently overridden.
function tryAutoDetectTaskEForCurrentRegion() {
  taskEState.auto = null;
  if (!taskEState.wb || taskEState.region !== "US" || !taskEState.itemSheet) return;
  try {
    taskEState.auto = taskE.autoDetectUsSummaryTable(taskERawRows(taskEState.itemSheet));
  } catch (e) {
    taskEState.auto = null;
  }
}

async function handleTaskETikTokFile(file) {
  const infoBox = document.getElementById("task-e-file-info");
  infoBox.innerHTML = "";
  if (!file) {
    taskEState.wb = null;
    taskEState.sheets = [];
    taskEState.itemSheet = null;
    taskEState.feeSheet = null;
    taskEState.auto = null;
    renderTaskEConfig();
    return;
  }
  const source = await loadWorkbookOrCsv(file);
  if (!source.wb) {
    infoBox.appendChild(h("p", { class: "error", text: "This file isn't a multi-tab Excel workbook (CSV/PDF aren't supported here) — upload the original .xlsx export." }));
    return;
  }
  taskEState.wb = source.wb;
  taskEState.sheets = io.listSheets(source.wb) || [];
  const hint = TASK_E_REGION_INFO[taskEState.region];
  const guess = taskEState.sheets.find((s) => taskC.normText(s).includes(taskC.normText(hint.sheetHint)));
  taskEState.itemSheet = guess || taskEState.sheets[0] || null;
  taskEState.feeSheet = taskEState.itemSheet;
  infoBox.appendChild(h("p", { class: "caption", text: `Loaded. Sheets: ${taskEState.sheets.join(", ")}` }));
  tryAutoDetectTaskE();
  renderTaskEConfig();
}

function taskEBuildBundleUI(container, unresolvedBundles) {
  container.innerHTML = "";
  if (!unresolvedBundles.length) return;
  container.appendChild(h("h4", { text: "Virtual bundle components needed" }));
  container.appendChild(h("p", { class: "caption", text: "Each name below matched \"(virtual bundle)\" but has no component mapping yet. Enter component item numbers, comma-separated — price/net amount is split evenly across them unless the user says otherwise." }));
  for (const b of unresolvedBundles) {
    const key = b.name;
    const wrap = h("div", { class: "file-row" });
    wrap.appendChild(h("label", { text: `${key} (row ${b.row}): ` }));
    const input = h("input", { type: "text", placeholder: "e.g. IM8-COMP-1, IM8-COMP-2" });
    const existing = taskEState.bundleCompositions[key];
    if (existing) input.value = existing.composition.map((c) => c.item).join(", ");
    input.addEventListener("change", () => {
      const items = input.value.split(",").map((s) => s.trim()).filter(Boolean);
      taskEState.bundleCompositions[key] = { composition: items.map((item) => ({ item, productName: "" })) };
    });
    wrap.appendChild(input);
    container.appendChild(wrap);
  }
  const btn = h("button", { text: "Rebuild with these components" });
  btn.addEventListener("click", () => (taskEState.auto ? computeTaskEAuto() : computeTaskE()));
  container.appendChild(btn);
}

function computeTaskE() {
  const resultsBox = document.getElementById("task-e-results");
  const bundleBox = document.getElementById("task-e-bundles");
  resultsBox.innerHTML = "";
  bundleBox.innerHTML = "";

  if (!taskEState.itemSheet || !taskEState.itemRange || !taskEState.itemCols.sku || !taskEState.itemCols.qty) {
    resultsBox.appendChild(h("p", { class: "error", text: "Fill in the item table's sheet, range, SKU column, and Quantity column at minimum." }));
    return;
  }
  let itemRange;
  try {
    itemRange = parseTaskERowRange(taskEState.itemRange);
  } catch (e) {
    resultsBox.appendChild(h("p", { class: "error", text: `Invalid item table range: ${e.message}` }));
    return;
  }

  let itemRecords, skippedBlankRows;
  try {
    ({ records: itemRecords, skippedBlankRows } = taskE.extractRowRecords(taskERawRows(taskEState.itemSheet), itemRange, taskEState.itemCols));
  } catch (e) {
    resultsBox.appendChild(h("p", { class: "error", text: `Item table extraction failed: ${e.message}` }));
    return;
  }
  if (!itemRecords.length) {
    resultsBox.appendChild(h("p", { class: "warning", text: "No item rows found in that range — check the sheet/range/SKU column above." }));
    return;
  }

  const regionInfo = TASK_E_REGION_INFO[taskEState.region];
  const { lines: fgLines, unresolvedBundles } = taskE.buildFgLines(itemRecords, regionInfo.warehouse, regionInfo.location, taskEState.bundleCompositions, taskFState.itemMaster);

  if (unresolvedBundles.length) {
    taskEBuildBundleUI(bundleBox, unresolvedBundles);
    resultsBox.appendChild(h("p", { class: "warning", text: `${unresolvedBundles.length} virtual bundle SKU(s) need component mapping before SO lines can be built — see below.` }));
    return;
  }

  let feeRecords = [];
  if (taskEState.feeSheet) {
    const feeRaw = taskERawRows(taskEState.feeSheet);
    try {
      if (taskEState.feeMode === "rowwise") {
        if (taskEState.feeRange && taskEState.feeCols.feeType && taskEState.feeCols.amount) {
          const feeRange = parseTaskERowRange(taskEState.feeRange);
          const { records } = taskE.extractRowRecords(feeRaw, feeRange, {
            sku: taskEState.feeCols.feeType, itemCode: taskEState.feeCols.itemCode, amount: taskEState.feeCols.amount,
          });
          feeRecords = records.map((r) => ({ feeType: r.sku, itemCode: r.itemCode, amount: r.amount }));
        }
      } else {
        const t = taskEState.feeTransposed;
        if (t.startCol && t.endCol && t.feeTypeRow && t.amountRow) {
          feeRecords = taskE.extractTransposedFeeRecords(feeRaw, {
            startCol: t.startCol, endCol: t.endCol,
            feeTypeRow: parseInt(t.feeTypeRow, 10),
            itemCodeRow: t.itemCodeRow ? parseInt(t.itemCodeRow, 10) : parseInt(t.feeTypeRow, 10),
            amountRow: parseInt(t.amountRow, 10),
          });
        }
      }
    } catch (e) {
      resultsBox.appendChild(h("p", { class: "error", text: `Fee table extraction failed: ${e.message}` }));
      return;
    }
  }

  const { lines: feeLines, zeroSkipped, unresolvedItems } = taskE.buildFeeLines(feeRecords);
  const table = taskE.buildSoLineTable(fgLines, feeLines);

  if (unresolvedItems.length) {
    resultsBox.appendChild(h("p", { class: "warning", text: `${unresolvedItems.length} fee row(s) have no item-code mapping and were excluded from the output: ${unresolvedItems.map((u) => u.feeType).join(", ")}. Add an Item code column above, or check the file's own mapping table.` }));
  }
  if (zeroSkipped.length) {
    resultsBox.appendChild(h("p", { class: "caption", text: `${zeroSkipped.length} fee row(s) skipped ($0 total): ${zeroSkipped.join(", ")}` }));
  }
  if (skippedBlankRows && skippedBlankRows.length) {
    resultsBox.appendChild(h("p", { class: "caption", text: `${skippedBlankRows.length} blank row(s) within the item range were skipped: rows ${skippedBlankRows.join(", ")}` }));
  }

  const refTotal = parseFloat(taskEState.referenceTotal);
  if (isNaN(refTotal)) {
    resultsBox.appendChild(h("p", { class: "warning", text: "Enter the reference total above to check reconciliation before delivering this." }));
  } else {
    const rec = taskE.reconcile(table, refTotal);
    resultsBox.appendChild(
      h("p", {
        class: rec.reconciled ? "info" : "error",
        text: rec.reconciled
          ? `Reconciled: line total ${rec.sum.toFixed(2)} matches the reference total ${rec.referenceTotal.toFixed(2)}.`
          : `NOT reconciled: line total ${rec.sum.toFixed(2)} vs. reference ${rec.referenceTotal.toFixed(2)} (diff ${rec.diff.toFixed(2)}). Check for a missed Refund line, or whether the item/fee tables use different transaction-type filters (per the spec, this alone caused a $127 gap once).`,
      })
    );
  }

  const btn = h("button", { text: "Download SO lines (.xlsx)" });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Building file...";
    try {
      const buf = await io.toExcelBytes({ "SO lines": table });
      downloadBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${todayStamp()}_TikTok_${taskEState.region.replace("/", "-")}_SO_Lines.xlsx`);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
  resultsBox.appendChild(btn);

  const tblContainer = h("div", {});
  resultsBox.appendChild(tblContainer);
  renderTable(table, tblContainer, 200);
}

// ---------------- Task E — US auto-detected path ----------------
// Reads the file's own "Summary" pivot directly (see
// taskE.autoDetectUsSummaryTable's own comment for the exact landmarks),
// with no sheet/range/column configuration needed. Falls back to the
// manual form above whenever detection doesn't find what it expects.

function renderTaskEAutoPanel(configBox, previewBox) {
  const d = taskEState.auto.diagnostics;
  configBox.appendChild(h("p", {
    class: "info",
    text: `Auto-detected the "${taskEState.itemSheet}" tab's Summary layout — header row ${d.headerRow}, fee Grand Total row ${d.topGrandRow}, item table header row ${d.skuHeaderRow}, item table Grand Total row ${d.bottomGrandRow}.`,
  }));
  configBox.appendChild(h("p", {
    class: "caption",
    text: `Net sales: fee pivot ${d.topNetSales.toFixed(2)} vs. item table ${d.bottomNetSales.toFixed(2)} → Refund line ${d.refundAmount.toFixed(2)}. Reconciliation target (Net earnings): ${d.netEarnings.toFixed(2)}.`,
  }));
  const manualBtn = h("button", { class: "clear-btn", text: "Use manual configuration instead" });
  manualBtn.addEventListener("click", () => { taskEState.auto = null; renderTaskEConfig(); });
  configBox.appendChild(manualBtn);
  renderRawGridPreview(previewBox, taskERawRows(taskEState.itemSheet));
}

function computeTaskEAuto() {
  const resultsBox = document.getElementById("task-e-results");
  const bundleBox = document.getElementById("task-e-bundles");
  resultsBox.innerHTML = "";
  bundleBox.innerHTML = "";

  const auto = taskEState.auto;
  const regionInfo = TASK_E_REGION_INFO[taskEState.region];
  // The Summary tab never carries Product name or Unit — both are
  // backfilled from the same shared FG item master Task F uses (it's the
  // only place in the tool that captures a SKU's D365 Unit, not just its
  // name), flagging anything still unmapped rather than shipping a blank
  // Product name/Unit silently.
  const { lines: fgLines, unresolvedBundles } = taskE.buildFgLines(auto.itemRecords, regionInfo.warehouse, regionInfo.location, taskEState.bundleCompositions, taskFState.itemMaster);

  if (unresolvedBundles.length) {
    taskEBuildBundleUI(bundleBox, unresolvedBundles);
    resultsBox.appendChild(h("p", { class: "warning", text: `${unresolvedBundles.length} virtual bundle SKU(s) need component mapping before SO lines can be built — see below.` }));
    return;
  }

  const unmapped = Array.from(new Set(fgLines.filter((l) => !l["Product name"] || !l.Unit).map((l) => l["Item number"])));
  if (unmapped.length) {
    resultsBox.appendChild(h("p", {
      class: "warning",
      text: `${unmapped.length} SKU(s) have no Product name/Unit in the shared item master (Task F) — upload/extend it there, then come back and rebuild: ${unmapped.join(", ")}`,
    }));
  }

  const feeRecordsAll = auto.feeRecords.concat(auto.refundLine ? [auto.refundLine] : []);
  const { lines: feeLines, zeroSkipped } = taskE.buildSerLinesFromSignedAmounts(feeRecordsAll);
  const table = taskE.buildSoLineTable(fgLines, feeLines);

  if (zeroSkipped.length) {
    resultsBox.appendChild(h("p", { class: "caption", text: `${zeroSkipped.length} fee column(s) skipped ($0 total): ${zeroSkipped.join(", ")}` }));
  }

  const rec = taskE.reconcile(table, auto.referenceTotal);
  resultsBox.appendChild(
    h("p", {
      class: rec.reconciled ? "info" : "error",
      text: rec.reconciled
        ? `Reconciled: line total ${rec.sum.toFixed(2)} matches Net earnings ${rec.referenceTotal.toFixed(2)}.`
        : `NOT reconciled: line total ${rec.sum.toFixed(2)} vs. Net earnings ${rec.referenceTotal.toFixed(2)} (diff ${rec.diff.toFixed(2)}). Switch to manual configuration above and check the raw preview — this file's layout may differ from the one auto-detection was built against.`,
    })
  );

  const btn = h("button", { class: "run-btn", text: "Download SO lines (.xlsx)" });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Building file...";
    try {
      const buf = await io.toExcelBytes({ "SO lines": table });
      downloadBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${todayStamp()}_TikTok_${taskEState.region.replace("/", "-")}_SO_Lines.xlsx`);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
  resultsBox.appendChild(btn);

  const tblContainer = h("div", {});
  resultsBox.appendChild(tblContainer);
  renderTable(table, tblContainer, 200);
}

function renderTaskEConfig() {
  const configBox = document.getElementById("task-e-config");
  const previewBox = document.getElementById("task-e-preview");
  configBox.innerHTML = "";
  previewBox.innerHTML = "";
  document.getElementById("task-e-bundles").innerHTML = "";
  document.getElementById("task-e-results").innerHTML = "";

  document.getElementById("e-region-caption").textContent = TASK_E_REGION_INFO[taskEState.region].caption;

  if (!taskEState.wb) {
    configBox.appendChild(h("p", { class: "muted", text: "Upload a TikTok Transactions Details file to continue." }));
    return;
  }

  if (taskEState.auto) {
    renderTaskEAutoPanel(configBox, previewBox);
    computeTaskEAuto();
    return;
  }

  function sheetField(labelText, value, onChange) {
    const wrap = h("div", { class: "col-field" });
    wrap.appendChild(h("label", { text: labelText }));
    const select = h("select");
    taskEState.sheets.forEach((s) => select.appendChild(h("option", { value: s, text: s })));
    select.value = value || taskEState.sheets[0];
    select.addEventListener("change", () => {
      onChange(select.value);
      previewSelect.value = select.value;
      renderRawGridPreview(previewBox, taskERawRows(select.value));
    });
    wrap.appendChild(select);
    return { wrap, select };
  }
  function textField(labelText, value, onChange, placeholder) {
    const wrap = h("div", { class: "col-field" });
    wrap.appendChild(h("label", { text: labelText }));
    const input = h("input", { type: "text", value: value || "" });
    if (placeholder) input.placeholder = placeholder;
    input.addEventListener("change", () => onChange(input.value.trim()));
    wrap.appendChild(input);
    return wrap;
  }

  const previewWrap = h("div", { class: "col-field" });
  previewWrap.appendChild(h("label", { text: "Raw preview — sheet" }));
  const previewSelect = h("select");
  taskEState.sheets.forEach((s) => previewSelect.appendChild(h("option", { value: s, text: s })));
  previewSelect.value = taskEState.itemSheet || taskEState.sheets[0];
  previewSelect.addEventListener("change", () => renderRawGridPreview(previewBox, taskERawRows(previewSelect.value)));
  previewWrap.appendChild(previewSelect);
  configBox.appendChild(previewWrap);
  renderRawGridPreview(previewBox, taskERawRows(previewSelect.value));

  // --- Item (FG) table config ---
  const itemBox = h("div", { class: "upload-box" });
  itemBox.appendChild(h("h4", { text: "1. Item (FG) table" }));
  const itemGrid = h("div", { class: "col-grid" });
  itemGrid.appendChild(sheetField("Sheet", taskEState.itemSheet, (v) => { taskEState.itemSheet = v; }).wrap);
  itemGrid.appendChild(textField("Range (e.g. A23:D45)", taskEState.itemRange, (v) => { taskEState.itemRange = v; }, "A23:D45"));
  itemGrid.appendChild(textField("SKU column", taskEState.itemCols.sku, (v) => { taskEState.itemCols.sku = v; }, "A"));
  itemGrid.appendChild(textField("Product name column", taskEState.itemCols.productName, (v) => { taskEState.itemCols.productName = v; }, "B"));
  itemGrid.appendChild(textField("Unit price column", taskEState.itemCols.unitPrice, (v) => { taskEState.itemCols.unitPrice = v; }, "C"));
  itemGrid.appendChild(textField("Discount column (optional)", taskEState.itemCols.discount, (v) => { taskEState.itemCols.discount = v; }));
  itemGrid.appendChild(textField("Quantity column", taskEState.itemCols.qty, (v) => { taskEState.itemCols.qty = v; }, "D"));
  itemBox.appendChild(itemGrid);
  configBox.appendChild(itemBox);

  // --- Fee table config ---
  const feeBox = h("div", { class: "upload-box" });
  feeBox.appendChild(h("h4", { text: "2. Fee/service table" }));
  const modeWrap = h("div", { class: "col-field" });
  modeWrap.appendChild(h("label", { text: "Layout" }));
  const modeSelect = h("select");
  modeSelect.appendChild(h("option", { value: "rowwise", text: "One fee per row" }));
  modeSelect.appendChild(h("option", { value: "transposed", text: "Transposed — fee types across columns (US layout)" }));
  modeSelect.value = taskEState.feeMode;
  modeSelect.addEventListener("change", () => { taskEState.feeMode = modeSelect.value; renderTaskEConfig(); });
  modeWrap.appendChild(modeSelect);
  feeBox.appendChild(modeWrap);

  const feeGrid = h("div", { class: "col-grid" });
  feeGrid.appendChild(sheetField("Sheet", taskEState.feeSheet, (v) => { taskEState.feeSheet = v; }).wrap);
  if (taskEState.feeMode === "rowwise") {
    feeGrid.appendChild(textField("Range", taskEState.feeRange, (v) => { taskEState.feeRange = v; }, "A2:D30"));
    feeGrid.appendChild(textField("Fee type column", taskEState.feeCols.feeType, (v) => { taskEState.feeCols.feeType = v; }, "A"));
    feeGrid.appendChild(textField("Item code column (blank if not in file)", taskEState.feeCols.itemCode, (v) => { taskEState.feeCols.itemCode = v; }));
    feeGrid.appendChild(textField("Total amount in SO column", taskEState.feeCols.amount, (v) => { taskEState.feeCols.amount = v; }, "D"));
  } else {
    feeGrid.appendChild(textField("Start column", taskEState.feeTransposed.startCol, (v) => { taskEState.feeTransposed.startCol = v; }, "D"));
    feeGrid.appendChild(textField("End column", taskEState.feeTransposed.endCol, (v) => { taskEState.feeTransposed.endCol = v; }, "L"));
    feeGrid.appendChild(textField("Fee type row", taskEState.feeTransposed.feeTypeRow, (v) => { taskEState.feeTransposed.feeTypeRow = v; }, "11"));
    feeGrid.appendChild(textField("Item code row", taskEState.feeTransposed.itemCodeRow, (v) => { taskEState.feeTransposed.itemCodeRow = v; }, "12"));
    feeGrid.appendChild(textField("Amount row (varies — confirm in the preview)", taskEState.feeTransposed.amountRow, (v) => { taskEState.feeTransposed.amountRow = v; }));
  }
  feeBox.appendChild(feeGrid);
  configBox.appendChild(feeBox);

  // --- Reference total ---
  const refBox = h("div", { class: "upload-box" });
  refBox.appendChild(h("h4", { text: "3. Reconciliation" }));
  refBox.appendChild(h("p", { class: "caption", text: "Enter the source file's own reference total (\"Total SO Amount\", a Grand Total / Net Earnings row) — the finished SO must match this exactly (mandatory, every time)." }));
  const refInput = h("input", { type: "number", step: "0.01", value: taskEState.referenceTotal });
  refInput.addEventListener("change", () => { taskEState.referenceTotal = refInput.value; });
  refBox.appendChild(refInput);
  configBox.appendChild(refBox);

  const buildBtn = h("button", { class: "run-btn", text: "Build SO lines" });
  buildBtn.addEventListener("click", () => computeTaskE());
  configBox.appendChild(buildBtn);
}

function renderTaskE() {
  renderTaskEConfig();
}

// ---------------- Task F ----------------

// FG/SER item-name overrides persisted in this browser (see task_f.js's
// AMAZON_ITEM_MASTER_SEED/AMAZON_SER_NAME_SEED for the built-in defaults) —
// separate from Task A's item master since Amazon needs the D365 unit of
// measure too, not just the product name.
const AMAZON_ITEM_MASTER_STORAGE_KEY = "im8OpsToolAmazonItemMasterV1";

function loadAmazonItemMasterFromStorage() {
  try {
    const raw = localStorage.getItem(AMAZON_ITEM_MASTER_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { ...taskF.AMAZON_ITEM_MASTER_SEED };
  } catch (e) {
    return { ...taskF.AMAZON_ITEM_MASTER_SEED };
  }
}
function saveAmazonItemMasterToStorage(map) {
  try {
    localStorage.setItem(AMAZON_ITEM_MASTER_STORAGE_KEY, JSON.stringify(map));
  } catch (e) {
    // Storage disabled/full — still works for this page load.
  }
}

const taskFState = {
  wb: null,
  fileName: "",
  itemMaster: loadAmazonItemMasterFromStorage(),
  serNames: { ...taskF.AMAZON_SER_NAME_SEED },
};

async function handleTaskFAmazonFile(file) {
  const infoBox = document.getElementById("task-f-file-info");
  infoBox.innerHTML = "";
  document.getElementById("task-f-results").innerHTML = "";
  if (!file) {
    taskFState.wb = null;
    taskFState.fileName = "";
    return;
  }
  const source = await loadWorkbookOrCsv(file);
  if (!source.wb) {
    infoBox.appendChild(h("p", { class: "error", text: "This isn't a multi-tab Excel workbook — upload the original .xlsx transactions export." }));
    return;
  }
  const sheets = io.listSheets(source.wb) || [];
  const summarySheet = sheets.find((s) => taskC.normText(s).includes("summary")) || sheets[0];
  const skuRefundSheet = sheets.find((s) => taskC.normText(s).includes("sku") && taskC.normText(s).includes("refund"));
  if (!summarySheet || !skuRefundSheet) {
    infoBox.appendChild(h("p", { class: "error", text: `Couldn't find both a "Summary" and a "SKU + Refund" tab in this file. Sheets found: ${sheets.join(", ")}` }));
    return;
  }
  taskFState.wb = source.wb;
  taskFState.fileName = file.name;
  taskFState.summarySheet = summarySheet;
  taskFState.skuRefundSheet = skuRefundSheet;
  infoBox.appendChild(h("p", { class: "caption", text: `Loaded '${file.name}'. Summary tab: '${summarySheet}'. SKU + Refund tab: '${skuRefundSheet}'.` }));
  computeTaskF();
}

function renderAmazonItemMasterEditor(container, unmapped) {
  container.innerHTML = "";
  container.appendChild(h("h4", { text: "FG item master (Item number → Product name / Unit)" }));
  container.appendChild(h("p", { class: "caption", text: "Saved in this browser and reused every month. Only new/unrecognized SKUs need filling in below." }));
  if (unmapped.length) {
    container.appendChild(h("p", { class: "warning", text: `Unmapped item number(s) — fill these in and rebuild: ${unmapped.join(", ")}` }));
  }
  const grid = h("div", { class: "col-grid" });
  for (const sku of unmapped) {
    const wrap = h("div", { class: "file-row" });
    wrap.appendChild(h("label", { text: sku + ": " }));
    const nameInput = h("input", { type: "text", placeholder: "Product name" });
    const unitInput = h("input", { type: "text", placeholder: "Unit (e.g. Box, Set, Pouch)" });
    const save = () => {
      if (!nameInput.value.trim() || !unitInput.value.trim()) return;
      taskFState.itemMaster[sku] = { name: nameInput.value.trim(), unit: unitInput.value.trim() };
      saveAmazonItemMasterToStorage(taskFState.itemMaster);
    };
    nameInput.addEventListener("change", save);
    unitInput.addEventListener("change", save);
    wrap.appendChild(nameInput);
    wrap.appendChild(unitInput);
    grid.appendChild(wrap);
  }
  container.appendChild(grid);
  if (unmapped.length) {
    const rebuildBtn = h("button", { text: "Rebuild with these mappings" });
    rebuildBtn.addEventListener("click", () => computeTaskF());
    container.appendChild(rebuildBtn);
  }
}

function computeTaskF() {
  const resultsBox = document.getElementById("task-f-results");
  const masterBox = document.getElementById("task-f-item-master");
  resultsBox.innerHTML = "";
  if (!taskFState.wb) { ops2SyncRun("tab-f", false, 1); return; }

  let summaryResult, orderRecords;
  try {
    const summaryRaw = io.sheetToRawRows(taskFState.wb, taskFState.summarySheet, null);
    summaryResult = taskF.extractAmazonSummary(summaryRaw, taskFState.serNames);
    const skuRefundRaw = io.sheetToRawRows(taskFState.wb, taskFState.skuRefundSheet, null);
    orderRecords = taskF.extractAmazonOrderLines(skuRefundRaw);
  } catch (e) {
    ops2SyncRun("tab-f", false, 0);
    resultsBox.appendChild(h("p", { class: "error", text: e.message }));
    return;
  }
  ops2SyncRun("tab-f", true, 0);

  const { lines: fgLines, unmapped } = taskF.buildAmazonFgLines(orderRecords, taskFState.itemMaster);
  renderAmazonItemMasterEditor(masterBox, unmapped);

  const serLines = taskF.buildAmazonSerLines(summaryResult.serLines);
  const table = taskF.buildAmazonSoLineTable(fgLines, serLines);
  const rec = taskF.amazonReconcile(table, summaryResult.netSales);

  const summaryLine = h("p", {
    class: rec.reconciled ? "info" : "error",
    text: `${fgLines.length} order line(s) + ${serLines.length} SER line(s) = ${table.length} row(s). ` +
      `Sum of Net amount: ${rec.sum.toFixed(2)} vs Net sales: ${rec.netSales.toFixed(2)} ` +
      (rec.reconciled ? "— reconciled to the cent." : `— OFF BY ${rec.diff.toFixed(2)}. Check refund double-count, the column-M sign, and whether Duty & Tax nets to ~0 before downloading.`),
  });
  resultsBox.appendChild(summaryLine);

  if (unmapped.length) {
    resultsBox.appendChild(h("p", { class: "warning", text: "Fill in the item master above and rebuild before downloading — unmapped rows have blank Product name / Unit." }));
  }

  const btn = h("button", { class: "run-btn", text: "Download D365 SO Lines (.xlsx)" });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Building file...";
    try {
      const buf = await io.toExcelBytes({ "Sheet1": table });
      const stamp = taskFState.fileName.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "_") || todayStamp();
      downloadBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `Amazon_SO_Lines_Completed_${stamp}.xlsx`);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
  resultsBox.appendChild(btn);

  const tblContainer = h("div", {});
  resultsBox.appendChild(tblContainer);
  renderTable(table, tblContainer, 200);
}

function renderTaskF() {
  const masterBox = document.getElementById("task-f-item-master");
  if (masterBox && !taskFState.wb) renderAmazonItemMasterEditor(masterBox, []);
}

// ---------------- Task G ----------------

// Rate cards are the user's own commercial data (never shipped with the
// tool) — maintained in the browser and persisted here, same pattern as
// Task F's item master.
const FREIGHT_RATE_CARDS_STORAGE_KEY = "im8OpsToolFreightRateCardsV1";

function loadFreightRateCardsFromStorage() {
  const defaults = taskG.defaultRateCards();
  try {
    const raw = localStorage.getItem(FREIGHT_RATE_CARDS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    // Cover a warehouse that has no saved cards yet (e.g. this tool was
    // extended with a new warehouse after the user's last save).
    for (const wh of taskG.FREIGHT_WAREHOUSES) {
      if (!parsed[wh.id] || !parsed[wh.id].length) parsed[wh.id] = defaults[wh.id];
    }
    return parsed;
  } catch (e) {
    return defaults;
  }
}
function saveFreightRateCardsToStorage(cards) {
  try {
    localStorage.setItem(FREIGHT_RATE_CARDS_STORAGE_KEY, JSON.stringify(cards));
  } catch (e) {
    // Storage disabled/full — still works for this page load.
  }
}

const taskGState = {
  rateCards: loadFreightRateCardsFromStorage(),
  warehouseId: taskG.FREIGHT_WAREHOUSES[0].id,
  rateCardId: null,
  dest: {}, // { country } and/or { zone } and/or { zip }, depending on the card's zone source
};

function taskGCurrentCards() {
  return taskGState.rateCards[taskGState.warehouseId] || [];
}
function taskGCurrentCard() {
  const cards = taskGCurrentCards();
  return cards.find((c) => c.id === taskGState.rateCardId) || cards[0] || null;
}

function renderTaskGWarehouseSelect() {
  const select = document.getElementById("g-warehouse");
  select.innerHTML = "";
  taskG.FREIGHT_WAREHOUSES.forEach((w) => select.appendChild(h("option", { value: w.id, text: w.name })));
  select.value = taskGState.warehouseId;
}

function renderTaskGRateCardSelect() {
  const select = document.getElementById("g-ratecard");
  select.innerHTML = "";
  const cards = taskGCurrentCards();
  cards.forEach((c) => select.appendChild(h("option", { value: c.id, text: c.name })));
  if (!cards.find((c) => c.id === taskGState.rateCardId)) {
    taskGState.rateCardId = cards.length ? cards[0].id : null;
  }
  if (taskGState.rateCardId) select.value = taskGState.rateCardId;
}

function renderTaskGDest() {
  const box = document.getElementById("g-dest");
  box.innerHTML = "";
  const card = taskGCurrentCard();
  if (!card) {
    box.appendChild(h("p", { class: "warning", text: "No rate card for this warehouse yet — add one below." }));
    return;
  }

  if (card.zoneSource === "usps") {
    const wh = taskG.getWarehouse(card.warehouseId);
    const wrap = h("div", { class: "col-field" });
    wrap.appendChild(h("label", { text: "Destination ZIP code (US)" }));
    const input = h("input", { type: "text", placeholder: "e.g. 90210" });
    input.value = taskGState.dest.zip || "";
    const info = h("p", { class: "caption" });
    const updateInfo = () => {
      const z = taskG.lookupUspsZone(wh.uspsOriginZip3, input.value);
      if (z.error) {
        info.textContent = input.value.trim() ? z.error : "";
        info.className = input.value.trim() ? "error" : "caption";
      } else {
        info.textContent = `USPS Zone ${z.zone}${z.raw !== z.zone ? ` (chart shows "${z.raw}")` : ""} from ${wh.name}.`;
        info.className = "caption";
      }
    };
    input.addEventListener("input", () => { taskGState.dest = { zip: input.value.trim() }; updateInfo(); });
    wrap.appendChild(input);
    box.appendChild(wrap);
    box.appendChild(info);
    updateInfo();
    return;
  }

  if (card.zones.length === 1) {
    taskGState.dest = { zone: card.zones[0] };
    box.appendChild(h("p", { class: "caption", text: `Single rate zone: ${card.zones[0]}.` }));
    return;
  }

  const countries = Object.keys(card.countryZoneMap);
  const grid = h("div", { class: "col-grid" });
  if (countries.length) {
    const cWrap = h("div", { class: "col-field" });
    cWrap.appendChild(h("label", { text: "Destination country" }));
    const cSelect = h("select", {});
    countries.forEach((c) => cSelect.appendChild(h("option", { value: c, text: `${c} → ${card.countryZoneMap[c]}` })));
    cSelect.addEventListener("change", () => { taskGState.dest = { country: cSelect.value }; });
    taskGState.dest = { country: cSelect.value };
    cWrap.appendChild(cSelect);
    grid.appendChild(cWrap);
  }
  const zWrap = h("div", { class: "col-field" });
  zWrap.appendChild(h("label", { text: countries.length ? "...or pick a zone directly" : "Destination zone" }));
  const zSelect = h("select", {});
  if (countries.length) zSelect.appendChild(h("option", { value: "", text: "(use country above)" }));
  card.zones.forEach((z) => zSelect.appendChild(h("option", { value: z, text: z })));
  zSelect.addEventListener("change", () => { if (zSelect.value) taskGState.dest = { zone: zSelect.value }; });
  zWrap.appendChild(zSelect);
  grid.appendChild(zWrap);
  box.appendChild(grid);
}

function renderTaskGWeightConverted() {
  const kgInput = document.getElementById("g-weight-kg");
  const caption = document.getElementById("g-weight-converted");
  const kg = parseFloat(kgInput.value);
  if (!kg || kg <= 0) { caption.textContent = ""; return; }
  const lb = taskG.convertWeight(kg, "kg", "lb");
  const oz = taskG.convertWeight(kg, "kg", "oz");
  caption.textContent = `= ${lb.toFixed(2)} lb = ${oz.toFixed(1)} oz`;
}

function computeTaskGQuote() {
  const resultBox = document.getElementById("g-quote-result");
  resultBox.innerHTML = "";
  const card = taskGCurrentCard();
  if (!card) { resultBox.appendChild(h("p", { class: "error", text: "Pick or add a rate card first." })); return; }

  const totalWeightKg = parseFloat(document.getElementById("g-weight-kg").value);
  const parcelCount = parseInt(document.getElementById("g-parcels").value, 10) || 1;
  const l = parseFloat(document.getElementById("g-dim-l").value);
  const w = parseFloat(document.getElementById("g-dim-w").value);
  const ht = parseFloat(document.getElementById("g-dim-h").value);
  const dimUnit = document.getElementById("g-dim-unit").value;
  const dims = (l > 0 && w > 0 && ht > 0) ? { length: l, width: w, height: ht, unit: dimUnit } : null;

  const quote = taskG.quoteFreight({ card, totalWeightKg, parcelCount, dims, dest: taskGState.dest });
  if (quote.error) {
    resultBox.appendChild(h("p", { class: "error", text: quote.error }));
    return;
  }

  resultBox.appendChild(h("p", { class: "info", text:
    `Chargeable weight: ${quote.perParcelWeight.toFixed(2)} ${quote.weightUnit} per parcel × ${quote.parcelCount} parcel(s)` }));
  const surchargeNote = quote.flatSurcharge ? ` (rate ${quote.baseCost.toFixed(2)} + flat surcharge ${quote.flatSurcharge.toFixed(2)})` : "";
  resultBox.appendChild(h("p", { class: "info", text:
    `Zone/rate used: ${quote.zone}${quote.zoneRaw !== quote.zone ? ` (chart shows "${quote.zoneRaw}")` : ""} — per-parcel cost ${quote.perParcelCost.toFixed(2)}${surchargeNote}` }));
  const totalP = h("p", { class: "info", text: `Estimated total freight cost: ${quote.totalCost.toFixed(2)}` });
  totalP.style.fontSize = "1.25rem";
  totalP.style.fontWeight = "800";
  resultBox.appendChild(totalP);
  if (card.notes) resultBox.appendChild(h("p", { class: "caption", text: `Rate card notes: ${card.notes}` }));
}

function renderTaskGRateCardEditor() {
  const root = document.getElementById("g-ratecard-editor");
  root.innerHTML = "";
  root.appendChild(h("h4", { text: "Rate card editor" }));
  root.appendChild(h("p", { class: "caption", text: "Your own rate card data, saved in this browser. Add one card per destination scope (e.g. Local / EU / Rest of World) for the selected warehouse." }));

  const cards = taskGCurrentCards();
  const wh = taskG.getWarehouse(taskGState.warehouseId);

  const listWrap = h("div", { class: "col-grid" });
  cards.forEach((card) => {
    const isActive = card.id === taskGState.rateCardId;
    const btn = h("button", { class: isActive ? "run-btn" : "clear-btn", text: card.name });
    btn.addEventListener("click", () => { taskGState.rateCardId = card.id; taskGState.dest = {}; renderTaskG(); });
    listWrap.appendChild(btn);
  });
  root.appendChild(listWrap);

  const addBtn = h("button", { class: "clear-btn", text: "+ Add new rate card" });
  addBtn.addEventListener("click", () => {
    const card = taskG.emptyManualCard(taskGState.warehouseId, `New rate card ${cards.length + 1}`, wh.weightUnit, wh.dimUnit);
    taskGState.rateCards[taskGState.warehouseId].push(card);
    taskGState.rateCardId = card.id;
    saveFreightRateCardsToStorage(taskGState.rateCards);
    renderTaskG();
  });
  root.appendChild(addBtn);

  const card = taskGCurrentCard();
  if (!card) return;

  root.appendChild(h("hr", { class: "ops2-hr" }));

  const nameWrap = h("div", { class: "col-field" });
  nameWrap.appendChild(h("label", { text: "Rate card name" }));
  const nameInput = h("input", { type: "text" });
  nameInput.value = card.name;
  nameInput.addEventListener("change", () => {
    card.name = nameInput.value.trim() || card.name;
    saveFreightRateCardsToStorage(taskGState.rateCards);
    renderTaskG();
  });
  nameWrap.appendChild(nameInput);
  root.appendChild(nameWrap);

  if (cards.length > 1) {
    const delBtn = h("button", { class: "clear-btn", text: "Delete this rate card" });
    delBtn.addEventListener("click", () => {
      taskGState.rateCards[taskGState.warehouseId] = cards.filter((c) => c.id !== card.id);
      taskGState.rateCardId = null;
      saveFreightRateCardsToStorage(taskGState.rateCards);
      renderTaskG();
    });
    root.appendChild(delBtn);
  }

  const cfgGrid = h("div", { class: "col-grid" });

  const modeWrap = h("div", { class: "col-field" });
  modeWrap.appendChild(h("label", { text: "Pricing mode" }));
  const modeSelect = h("select", {});
  modeSelect.appendChild(h("option", { value: "bracket", text: "Weight brackets (flat price per range)" }));
  modeSelect.appendChild(h("option", { value: "perUnit", text: "Base fee + per-unit rate" }));
  modeSelect.value = card.mode;
  modeSelect.addEventListener("change", () => { card.mode = modeSelect.value; saveFreightRateCardsToStorage(taskGState.rateCards); renderTaskG(); });
  modeWrap.appendChild(modeSelect);
  cfgGrid.appendChild(modeWrap);

  const wuWrap = h("div", { class: "col-field" });
  wuWrap.appendChild(h("label", { text: "Rate card's weight unit" }));
  const wuSelect = h("select", {});
  ["kg", "lb", "oz"].forEach((u) => wuSelect.appendChild(h("option", { value: u, text: u })));
  wuSelect.value = card.weightUnit;
  wuSelect.addEventListener("change", () => { card.weightUnit = wuSelect.value; saveFreightRateCardsToStorage(taskGState.rateCards); renderTaskG(); });
  wuWrap.appendChild(wuSelect);
  cfgGrid.appendChild(wuWrap);

  if (wh.uspsOriginZip3) {
    const zsWrap = h("div", { class: "col-field" });
    zsWrap.appendChild(h("label", { text: "Destination zone source" }));
    const zsSelect = h("select", {});
    zsSelect.appendChild(h("option", { value: "manual", text: "Manual zones / countries" }));
    zsSelect.appendChild(h("option", { value: "usps", text: "USPS zone (auto, from destination ZIP)" }));
    zsSelect.value = card.zoneSource;
    zsSelect.addEventListener("change", () => {
      card.zoneSource = zsSelect.value;
      if (card.zoneSource === "usps") {
        const zones = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
        card.zones = zones;
        card.countryZoneMap = {};
        for (const row of card.brackets) row.prices = Object.fromEntries(zones.map((z) => [z, row.prices[z] || 0]));
        card.perUnit = Object.fromEntries(zones.map((z) => [z, card.perUnit[z] || { base: 0, rate: 0, min: 0 }]));
      }
      taskGState.dest = {};
      saveFreightRateCardsToStorage(taskGState.rateCards);
      renderTaskG();
    });
    zsWrap.appendChild(zsSelect);
    cfgGrid.appendChild(zsWrap);
  }

  const divWrap = h("div", { class: "col-field" });
  divWrap.appendChild(h("label", { text: "Volumetric divisor (optional)" }));
  const divInput = h("input", { type: "number", min: "0", step: "1", placeholder: "e.g. 5000 (cm→kg) or 139 (in→lb)" });
  divInput.value = card.dimDivisor || "";
  divInput.addEventListener("change", () => { card.dimDivisor = parseFloat(divInput.value) || null; saveFreightRateCardsToStorage(taskGState.rateCards); });
  divWrap.appendChild(divInput);
  cfgGrid.appendChild(divWrap);

  const surWrap = h("div", { class: "col-field" });
  surWrap.appendChild(h("label", { text: "Flat surcharge per parcel (optional)" }));
  const surInput = h("input", { type: "number", min: "0", step: "0.01", placeholder: "e.g. fuel/peak-season fees that apply to every package" });
  surInput.value = card.flatSurcharge || "";
  surInput.addEventListener("change", () => { card.flatSurcharge = parseFloat(surInput.value) || 0; saveFreightRateCardsToStorage(taskGState.rateCards); });
  surWrap.appendChild(surInput);
  cfgGrid.appendChild(surWrap);

  root.appendChild(cfgGrid);

  const notesWrap = h("div", { class: "col-field" });
  notesWrap.appendChild(h("label", { text: "Notes (zone definitions, surcharges not included above, service restrictions, etc.)" }));
  const notesInput = h("textarea", { rows: "3", style: "width:100%;font:inherit;" });
  notesInput.value = card.notes || "";
  notesInput.addEventListener("change", () => { card.notes = notesInput.value; saveFreightRateCardsToStorage(taskGState.rateCards); });
  notesWrap.appendChild(notesInput);
  root.appendChild(notesWrap);

  if (card.zoneSource === "manual") {
    root.appendChild(h("h6", { text: "Destination zones" }));
    const zoneRow = h("div", { class: "col-grid" });
    card.zones.forEach((z) => {
      const chip = h("span", { class: "status-chip", text: `${z} ` });
      if (card.zones.length > 1) {
        const x = h("button", { class: "clear-btn", text: "×" });
        x.addEventListener("click", () => { taskG.removeZone(card, z); saveFreightRateCardsToStorage(taskGState.rateCards); renderTaskG(); });
        chip.appendChild(x);
      }
      zoneRow.appendChild(chip);
    });
    root.appendChild(zoneRow);

    const addZoneRow = h("div", { class: "file-row" });
    const addZoneInput = h("input", { type: "text", placeholder: "New zone name (e.g. EU, Rest of World)" });
    const addZoneBtn = h("button", { class: "clear-btn", text: "+ Add zone" });
    addZoneBtn.addEventListener("click", () => {
      taskG.addZone(card, addZoneInput.value);
      saveFreightRateCardsToStorage(taskGState.rateCards);
      renderTaskG();
    });
    addZoneRow.appendChild(addZoneInput);
    addZoneRow.appendChild(addZoneBtn);
    root.appendChild(addZoneRow);

    root.appendChild(h("h6", { text: "Country → zone mapping (optional — lets the calculator resolve a zone from a destination country)" }));
    const mapBox = h("div", {});
    Object.entries(card.countryZoneMap).forEach(([country, zone]) => {
      const row = h("div", { class: "file-row" });
      row.appendChild(h("span", { text: `${country} → ${zone}` }));
      const rm = h("button", { class: "clear-btn", text: "Remove" });
      rm.addEventListener("click", () => { delete card.countryZoneMap[country]; saveFreightRateCardsToStorage(taskGState.rateCards); renderTaskG(); });
      row.appendChild(rm);
      mapBox.appendChild(row);
    });
    root.appendChild(mapBox);

    const mapRow = h("div", { class: "file-row" });
    const countryInput = h("input", { type: "text", placeholder: "Country name" });
    const zoneSelectForMap = h("select", {});
    card.zones.forEach((z) => zoneSelectForMap.appendChild(h("option", { value: z, text: z })));
    const mapBtn = h("button", { class: "clear-btn", text: "+ Add mapping" });
    mapBtn.addEventListener("click", () => {
      const country = countryInput.value.trim();
      if (!country) return;
      card.countryZoneMap[country] = zoneSelectForMap.value;
      saveFreightRateCardsToStorage(taskGState.rateCards);
      renderTaskG();
    });
    mapRow.appendChild(countryInput);
    mapRow.appendChild(zoneSelectForMap);
    mapRow.appendChild(mapBtn);
    root.appendChild(mapRow);
  } else {
    root.appendChild(h("p", { class: "caption", text:
      `Zones: ${card.zones.join(", ")} — USPS zone, computed automatically from ${wh.name}'s ZIP and the destination ZIP entered above.` }));
  }

  root.appendChild(h("h6", { text: "Pricing" }));
  if (card.mode === "bracket") {
    const table = h("table", { class: "data-table" });
    const thead = h("thead", {}, [h("tr", {}, [
      h("th", { text: `Min (${card.weightUnit})` }),
      h("th", { text: `Max (${card.weightUnit}, blank = no limit)` }),
      ...card.zones.map((z) => h("th", { text: z })),
      h("th", { text: "" }),
    ])]);
    const tbody = h("tbody", {});
    card.brackets.forEach((row, idx) => {
      const tr = h("tr", {});
      const minInput = h("input", { type: "number", step: "0.01" });
      minInput.value = row.min;
      minInput.addEventListener("change", () => { row.min = parseFloat(minInput.value) || 0; saveFreightRateCardsToStorage(taskGState.rateCards); });
      tr.appendChild(h("td", {}, [minInput]));
      const maxInput = h("input", { type: "number", step: "0.01" });
      maxInput.value = row.max == null ? "" : row.max;
      maxInput.addEventListener("change", () => { row.max = maxInput.value === "" ? null : parseFloat(maxInput.value); saveFreightRateCardsToStorage(taskGState.rateCards); });
      tr.appendChild(h("td", {}, [maxInput]));
      card.zones.forEach((z) => {
        const priceInput = h("input", { type: "number", step: "0.01" });
        priceInput.value = row.prices[z] == null ? 0 : row.prices[z];
        priceInput.addEventListener("change", () => { row.prices[z] = parseFloat(priceInput.value) || 0; saveFreightRateCardsToStorage(taskGState.rateCards); });
        tr.appendChild(h("td", {}, [priceInput]));
      });
      const rmBtn = h("button", { class: "clear-btn", text: "Remove" });
      rmBtn.addEventListener("click", () => { taskG.removeBracketRow(card, idx); saveFreightRateCardsToStorage(taskGState.rateCards); renderTaskG(); });
      tr.appendChild(h("td", {}, [rmBtn]));
      tbody.appendChild(tr);
    });
    table.appendChild(thead);
    table.appendChild(tbody);
    root.appendChild(table);
    const addRowBtn = h("button", { class: "clear-btn", text: "+ Add weight bracket" });
    addRowBtn.addEventListener("click", () => { taskG.addBracketRow(card); saveFreightRateCardsToStorage(taskGState.rateCards); renderTaskG(); });
    root.appendChild(addRowBtn);
  } else {
    const table = h("table", { class: "data-table" });
    const thead = h("thead", {}, [h("tr", {}, [
      h("th", { text: "Zone" }), h("th", { text: "Base fee" }), h("th", { text: `Rate per ${card.weightUnit}` }), h("th", { text: "Minimum charge" }),
    ])]);
    const tbody = h("tbody", {});
    card.zones.forEach((z) => {
      if (!card.perUnit[z]) card.perUnit[z] = { base: 0, rate: 0, min: 0 };
      const cfg = card.perUnit[z];
      const tr = h("tr", {});
      tr.appendChild(h("td", { text: z }));
      const baseInput = h("input", { type: "number", step: "0.01" });
      baseInput.value = cfg.base;
      baseInput.addEventListener("change", () => { cfg.base = parseFloat(baseInput.value) || 0; saveFreightRateCardsToStorage(taskGState.rateCards); });
      tr.appendChild(h("td", {}, [baseInput]));
      const rateInput = h("input", { type: "number", step: "0.01" });
      rateInput.value = cfg.rate;
      rateInput.addEventListener("change", () => { cfg.rate = parseFloat(rateInput.value) || 0; saveFreightRateCardsToStorage(taskGState.rateCards); });
      tr.appendChild(h("td", {}, [rateInput]));
      const minInput = h("input", { type: "number", step: "0.01" });
      minInput.value = cfg.min;
      minInput.addEventListener("change", () => { cfg.min = parseFloat(minInput.value) || 0; saveFreightRateCardsToStorage(taskGState.rateCards); });
      tr.appendChild(h("td", {}, [minInput]));
      tbody.appendChild(tr);
    });
    table.appendChild(thead);
    table.appendChild(tbody);
    root.appendChild(table);
  }
}

function renderTaskG() {
  renderTaskGWarehouseSelect();
  renderTaskGRateCardSelect();
  renderTaskGDest();
  renderTaskGRateCardEditor();
}

function initTabs() {
  document.querySelectorAll(".tab-button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-button").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.add("active");
    });
  });

  const sideNav = document.getElementById("side-nav");
  const toggle = document.getElementById("side-nav-toggle");
  if (sideNav && toggle) {
    toggle.addEventListener("click", () => sideNav.classList.toggle("collapsed"));
  }
}

function wireClearButton(buttonId, inputId, kind) {
  document.getElementById(buttonId).addEventListener("click", () => {
    document.getElementById(inputId).value = "";
    handleTaskAFile(kind, null);
  });
}

// Wraps a file-input's change handler with the loading overlay. Clearing a
// file (calling the handler with null) is instant, so it skips the overlay.
function onFileChange(inputId, label, handler) {
  document.getElementById(inputId).addEventListener("change", (e) => {
    const files = e.target.files;
    if (!files || !files.length) return handler(e);
    withLoading(label, () => handler(e));
  });
}

function init() {
  initTabs();
  onFileChange("a-requested-file", "Loading requested inventory file...", (e) => handleTaskAFile("requested", e.target.files[0]));
  onFileChange("a-onhand-file", "Loading on-hand inventory file...", (e) => handleTaskAFile("onhand", e.target.files[0]));
  onFileChange("a-onorder-file", "Loading on-order file...", (e) => handleTaskAFile("onorder", e.target.files[0]));
  wireClearButton("a-requested-clear", "a-requested-file", "requested");
  wireClearButton("a-onhand-clear", "a-onhand-file", "onhand");
  wireClearButton("a-onorder-clear", "a-onorder-file", "onorder");
  onFileChange("a-item-master-file", "Loading item master file...", (e) => handleTaskAItemMasterFile(e.target.files[0]));
  document.getElementById("a-item-master-clear").addEventListener("click", () => { document.getElementById("a-item-master-file").value = ""; clearTaskAItemMaster(); });
  renderItemMasterStatus();
  onFileChange("b-so-file", "Loading open sales order list...", (e) => handleTaskBOpenSo(e.target.files[0]));
  onFileChange("b-ful-files", "Loading fulfillment report(s)...", (e) => handleTaskBFulfillmentFiles(Array.from(e.target.files)));
  onFileChange("b-onhand-file", "Loading on-hand inventory export...", (e) => handleTaskBOnhand(e.target.files[0]));
  document.getElementById("b-onhand-clear").addEventListener("click", () => { document.getElementById("b-onhand-file").value = ""; handleTaskBOnhand(null); });

  onFileChange("c-openso-file", "Loading Open SO workbook...", (e) => handleTaskCOpenSo(e.target.files[0]));
  onFileChange("c-batch-file", "Loading refund/cancel batch export...", (e) => handleTaskCBatch(e.target.files[0]));
  onFileChange("c-onhand-file", "Loading on-hand inventory export...", (e) => handleTaskCOnhand(e.target.files[0]));
  onFileChange("c-aging-file", "Loading inventory aging report...", (e) => handleTaskCAging(e.target.files[0]));
  onFileChange("c-ful-files", "Loading fulfillment report(s)...", (e) => handleTaskCFulfillmentFiles(Array.from(e.target.files)));
  document.getElementById("c-openso-clear").addEventListener("click", () => { document.getElementById("c-openso-file").value = ""; handleTaskCOpenSo(null); });
  document.getElementById("c-batch-clear").addEventListener("click", () => { document.getElementById("c-batch-file").value = ""; handleTaskCBatch(null); });
  document.getElementById("c-onhand-clear").addEventListener("click", () => { document.getElementById("c-onhand-file").value = ""; handleTaskCOnhand(null); });
  document.getElementById("c-aging-clear").addEventListener("click", () => { document.getElementById("c-aging-file").value = ""; handleTaskCAging(null); });

  onFileChange("d-report-file", "Loading damage/defective report...", (e) => handleTaskDReport(e.target.files[0]));
  onFileChange("d-onhand-file", "Loading on-hand inventory export...", (e) => handleTaskDOnhand(e.target.files[0]));
  onFileChange("d-aging-file", "Loading inventory aging report...", (e) => handleTaskDAging(e.target.files[0]));
  document.getElementById("d-report-clear").addEventListener("click", () => { document.getElementById("d-report-file").value = ""; handleTaskDReport(null); });
  document.getElementById("d-onhand-clear").addEventListener("click", () => { document.getElementById("d-onhand-file").value = ""; handleTaskDOnhand(null); });
  document.getElementById("d-aging-clear").addEventListener("click", () => { document.getElementById("d-aging-file").value = ""; handleTaskDAging(null); });

  onFileChange("e-tiktok-file", "Loading TikTok transactions file...", (e) => handleTaskETikTokFile(e.target.files[0]));
  document.getElementById("e-tiktok-clear").addEventListener("click", () => { document.getElementById("e-tiktok-file").value = ""; handleTaskETikTokFile(null); });
  document.getElementById("e-region").addEventListener("change", (e) => {
    taskEState.region = e.target.value;
    if (taskEState.wb) {
      const hint = TASK_E_REGION_INFO[taskEState.region];
      const guess = taskEState.sheets.find((s) => taskC.normText(s).includes(taskC.normText(hint.sheetHint)));
      taskEState.itemSheet = guess || taskEState.sheets[0] || null;
      taskEState.feeSheet = taskEState.itemSheet;
      tryAutoDetectTaskEForCurrentRegion();
    }
    renderTaskEConfig();
  });
  document.querySelectorAll("#e-region-seg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#e-region-seg button").forEach((b) => b.classList.remove("ops2-seg-active"));
      btn.classList.add("ops2-seg-active");
      const select = document.getElementById("e-region");
      select.value = btn.dataset.region;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });

  // ---- ops2 panel chrome: file counts, output empty-state, run button ----
  ops2InitFileCounts("tab-a", ["a-requested-file", "a-onhand-file"], ["a-onorder-file", "a-item-master-file"]);
  ops2InitEmptyState("tab-a");
  document.getElementById("a-run-btn").addEventListener("click", () => { taskAState.hasRun = true; renderTaskA(); });

  ops2InitFileCounts("tab-b", ["b-so-file", "b-ful-files"], ["b-onhand-file"]);
  ops2InitEmptyState("tab-b");
  document.getElementById("b-run-btn").addEventListener("click", () => {
    document.getElementById("task-b-results").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  ops2InitFileCounts("tab-c", ["c-openso-file", "c-batch-file", "c-ful-files", "c-onhand-file"], ["c-aging-file", "c-bundle-json"]);
  ops2InitEmptyState("tab-c");
  document.getElementById("c-run-btn").addEventListener("click", () => {
    document.getElementById("task-c-results").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  ops2InitFileCounts("tab-d", ["d-report-file"], ["d-onhand-file", "d-aging-file"]);
  ops2InitEmptyState("tab-d");
  document.getElementById("d-run-btn").addEventListener("click", () => {
    document.getElementById("task-d-results").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  ops2InitFileCounts("tab-e", ["e-tiktok-file"], []);
  ops2InitEmptyState("tab-e");

  onFileChange("f-amazon-file", "Loading Amazon transactions file...", (e) => handleTaskFAmazonFile(e.target.files[0]));
  document.getElementById("f-amazon-clear").addEventListener("click", () => { document.getElementById("f-amazon-file").value = ""; handleTaskFAmazonFile(null); });
  ops2InitFileCounts("tab-f", ["f-amazon-file"], []);
  ops2InitEmptyState("tab-f");

  document.getElementById("g-warehouse").addEventListener("change", (e) => {
    taskGState.warehouseId = e.target.value;
    taskGState.rateCardId = null;
    taskGState.dest = {};
    renderTaskG();
  });
  document.getElementById("g-ratecard").addEventListener("change", (e) => {
    taskGState.rateCardId = e.target.value;
    taskGState.dest = {};
    renderTaskG();
  });
  document.getElementById("g-weight-kg").addEventListener("input", renderTaskGWeightConverted);
  document.getElementById("g-calc-btn").addEventListener("click", computeTaskGQuote);

  renderTaskA();
  renderTaskB();
  renderTaskC();
  renderTaskD();
  renderTaskE();
  renderTaskF();
  renderTaskG();
}

document.addEventListener("DOMContentLoaded", init);
