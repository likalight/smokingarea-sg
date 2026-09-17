// Zero-dependency static server for public/. No npx, no network, no install.
//   node scripts/serve.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve public/ from this file, not the cwd, so it runs from anywhere.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.argv[2] || process.env.PORT || 5178);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel.endsWith('/')) rel += 'index.html';

  // Never serve outside public/, whatever the request says.
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    }).end(body);
  });
});

server.listen(PORT, () => console.log(`smokingarea.sg -> http://localhost:${PORT}`));
