// Assembles the single self-contained HTML file: inlines SheetJS (reading)
// and ExcelJS (writing) plus all our ported logic + UI, so it can be opened
// directly in a browser with no server and no external dependencies.
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const OUT_PATH = path.join(ROOT, "..", "IM8-Ops-Tool.html");

function read(p) {
  return fs.readFileSync(p, "utf8");
}

const template = read(path.join(ROOT, "template.html"));

const xlsxLib = read(path.join(ROOT, "node_modules", "xlsx", "dist", "xlsx.full.min.js"));
const exceljsLib = read(path.join(ROOT, "node_modules", "exceljs", "dist", "exceljs.min.js"));
const pdfjsLib = read(path.join(ROOT, "node_modules", "pdfjs-dist", "build", "pdf.min.js"));
const pdfjsWorkerSrc = read(path.join(ROOT, "node_modules", "pdfjs-dist", "build", "pdf.worker.min.js"));
const ioUtils = read(path.join(ROOT, "js", "io_utils.js"));
const skuRules = read(path.join(ROOT, "js", "sku_rules.js"));
const statusI18n = read(path.join(ROOT, "js", "status_i18n.js"));
const taskA = read(path.join(ROOT, "js", "task_a.js"));
const taskB = read(path.join(ROOT, "js", "task_b.js"));
const taskC = read(path.join(ROOT, "js", "task_c.js"));
const taskD = read(path.join(ROOT, "js", "task_d.js"));
const taskE = read(path.join(ROOT, "js", "task_e.js"));
const taskF = read(path.join(ROOT, "js", "task_f.js"));
const taskG = read(path.join(ROOT, "js", "task_g.js"));
const pdfExtract = read(path.join(ROOT, "js", "pdf_extract.js"));
const appJs = read(path.join(ROOT, "js", "app.js"));

// pdf.js's worker can't be a separate external file in a single self-
// contained HTML page — embed its source as a string, then at runtime build
// a Blob URL from it and point GlobalWorkerOptions.workerSrc there. Escape
// "</script" so the embedded source can't prematurely close our <script> tag.
const pdfjsWorkerLiteral = JSON.stringify(pdfjsWorkerSrc).replace(/<\/script/gi, "<\\/script");

let out = template
  .replace("<!--XLSX_LIB-->", () => xlsxLib)
  .replace("<!--EXCELJS_LIB-->", () => exceljsLib)
  .replace("<!--PDFJS_LIB-->", () => pdfjsLib)
  .replace("<!--PDFJS_WORKER_LITERAL-->", () => pdfjsWorkerLiteral)
  .replace("<!--IO_UTILS-->", () => ioUtils)
  .replace("<!--SKU_RULES-->", () => skuRules)
  .replace("<!--STATUS_I18N-->", () => statusI18n)
  .replace("<!--TASK_A-->", () => taskA)
  .replace("<!--TASK_B-->", () => taskB)
  .replace("<!--TASK_C-->", () => taskC)
  .replace("<!--TASK_D-->", () => taskD)
  .replace("<!--TASK_E-->", () => taskE)
  .replace("<!--TASK_F-->", () => taskF)
  .replace("<!--TASK_G-->", () => taskG)
  .replace("<!--PDF_EXTRACT-->", () => pdfExtract)
  .replace("<!--APP_JS-->", () => appJs);

fs.writeFileSync(OUT_PATH, out, "utf8");
console.log(`Built ${OUT_PATH} (${(out.length / 1024 / 1024).toFixed(2)} MB)`);
