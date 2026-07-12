// Zero-dependency static server for the ABO/GPC viewer.
// Serves ./public, exposes /healthz for Railway, and a stub /api/convert
// reserved for the future PDF -> GPC conversion step.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.gpc': 'text/plain; charset=windows-1250',
};

const send = (res, code, type, body) => {
  res.writeHead(code, { 'content-type': type });
  res.end(body);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Railway healthcheck
  if (url.pathname === '/healthz') return send(res, 200, TYPES['.json'], '{"ok":true}');

  // Reserved for the upcoming PDF -> GPC converter
  if (url.pathname === '/api/convert') {
    if (req.method !== 'POST') return send(res, 405, TYPES['.json'], '{"error":"method not allowed"}');
    return send(res, 501, TYPES['.json'], '{"error":"PDF -> GPC conversion not implemented yet"}');
  }

  // Static files (with path-traversal guard)
  const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = join(PUBLIC, rel);
  if (!filePath.startsWith(PUBLIC)) return send(res, 403, 'text/plain', 'Forbidden');

  try {
    const data = await readFile(filePath);
    send(res, 200, TYPES[extname(filePath)] || 'application/octet-stream', data);
  } catch {
    // fall back to the app shell so unknown paths still open the viewer
    try {
      const shell = await readFile(join(PUBLIC, 'index.html'));
      send(res, 200, TYPES['.html'], shell);
    } catch {
      send(res, 404, 'text/plain', 'Not found');
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ABO/GPC viewer running on http://0.0.0.0:${PORT}`);
});
