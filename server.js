// Zero-dependency server for the ABO/GPC toolkit.
// Serves ./public, /healthz for Railway, a stub /api/convert, and a
// server-side proxy to the Zásilkovna (Packeta) invoice API so that the
// API key/password never reach the browser. Credentials come from env vars.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

// --- Zásilkovna / Packeta credentials (set these in Railway → Variables) ---
const ZAS_BASE = 'https://www.zasilkovna.cz/api';
const ZAS_KEY = process.env.ZASILKOVNA_KEY || '';
const ZAS_PW  = process.env.ZASILKOVNA_PASSWORD || '';
// Optional access gate: if APP_TOKEN is set, /api/zasilkovna/* requires the
// matching token in the x-app-token header. If unset, the endpoints are open.
const APP_TOKEN = process.env.APP_TOKEN || '';

const zasConfigured = () => Boolean(ZAS_KEY && ZAS_PW);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
  '.gpc': 'text/plain; charset=windows-1250',
};
const JSONT = TYPES['.json'];
const send = (res, code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };

// Proxy a Zásilkovna endpoint. Only whitelisted params are forwarded; key and
// password are injected server-side. The full URL (with secrets) is never logged.
async function proxyZasilkovna(subpath, allowed, url, res) {
  if (!zasConfigured())
    return send(res, 503, JSONT, JSON.stringify({ error: 'Zásilkovna API není nakonfigurováno (chybí ZASILKOVNA_KEY / ZASILKOVNA_PASSWORD).' }));
  const target = new URL(ZAS_BASE + subpath);
  target.searchParams.set('key', ZAS_KEY);
  target.searchParams.set('password', ZAS_PW);
  for (const p of allowed) {
    const v = url.searchParams.get(p);
    if (v != null && v !== '') target.searchParams.set(p, v);
  }
  try {
    const upstream = await fetch(target, { headers: { Accept: '*/*' } });
    const buf = Buffer.from(await upstream.arrayBuffer());
    const ct = upstream.headers.get('content-type') || 'text/plain; charset=utf-8';
    res.writeHead(upstream.status, { 'content-type': ct, 'cache-control': 'no-store' });
    res.end(buf);
  } catch {
    // Deliberately do not include the target URL in the message/log.
    send(res, 502, JSONT, JSON.stringify({ error: 'Volání Zásilkovny selhalo.' }));
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/healthz') return send(res, 200, JSONT, '{"ok":true}');

  // Non-sensitive: lets the UI know whether the backend is ready and gated.
  if (path === '/api/zasilkovna/status')
    return send(res, 200, JSONT, JSON.stringify({ configured: zasConfigured(), tokenRequired: Boolean(APP_TOKEN) }));

  // Zásilkovna proxy routes
  if (path.startsWith('/api/zasilkovna/')) {
    if (APP_TOKEN && req.headers['x-app-token'] !== APP_TOKEN)
      return send(res, 401, JSONT, JSON.stringify({ error: 'Neplatný nebo chybějící přístupový token.' }));
    if (path === '/api/zasilkovna/invoices')       // list of invoices (CSV)
      return proxyZasilkovna('/invoice.csv', ['from', 'to', 'version', 'lang'], url, res);
    if (path === '/api/zasilkovna/packet')          // per-packet breakdown (CSV)
      return proxyZasilkovna('/invoice-packet.csv', ['number', 'var_symbol', 'version', 'lang', 'only_cod', 'cod_date'], url, res);
    if (path === '/api/zasilkovna/packet-pohoda')   // per-packet breakdown, Pohoda format
      return proxyZasilkovna('/invoice-packet-pohoda-payU.csv', ['number', 'var_symbol', 'lang'], url, res);
    if (path === '/api/zasilkovna/pdf')             // single invoice as PDF
      return proxyZasilkovna('/invoice.pdf', ['number', 'var_symbol'], url, res);
    return send(res, 404, JSONT, '{"error":"unknown endpoint"}');
  }

  if (path === '/api/convert') {
    if (req.method !== 'POST') return send(res, 405, JSONT, '{"error":"method not allowed"}');
    return send(res, 501, JSONT, '{"error":"PDF -> GPC conversion not implemented yet"}');
  }

  // Static files (with path-traversal guard)
  const rel = normalize(path === '/' ? '/index.html' : path);
  const filePath = join(PUBLIC, rel);
  if (!filePath.startsWith(PUBLIC)) return send(res, 403, 'text/plain', 'Forbidden');
  try {
    const data = await readFile(filePath);
    send(res, 200, TYPES[extname(filePath)] || 'application/octet-stream', data);
  } catch {
    try {
      const shell = await readFile(join(PUBLIC, 'index.html'));
      send(res, 200, TYPES['.html'], shell);
    } catch {
      send(res, 404, 'text/plain', 'Not found');
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ABO/GPC toolkit running on http://0.0.0.0:${PORT}  (Zásilkovna: ${zasConfigured() ? 'configured' : 'not configured'})`);
});
