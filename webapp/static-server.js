// Minimal static file server (no deps) so the built HTML page can be viewed
// via http://localhost — the sandboxed Browser tool can't load file:// URLs.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = process.env.PORT || 8734;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".xlsx": "application/octet-stream" };

http.createServer((req, res) => {
  let filePath = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (req.url === "/") filePath = path.join(ROOT, "IM8-Open-SO-Checking-Tool-Operations.html");
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found: " + filePath);
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Serving ${ROOT} on http://localhost:${PORT}`));
