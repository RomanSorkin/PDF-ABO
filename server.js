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
const ZAS_KEY = (process.env.ZASILKOVNA_KEY || '').trim();
const ZAS_PW  = (process.env.ZASILKOVNA_PASSWORD || '').trim();
// Optional access gate: if APP_TOKEN is set, /api/zasilkovna/* requires the
// matching token in the x-app-token header. If unset, the endpoints are open.
const APP_TOKEN = process.env.APP_TOKEN || '';

// --- Gmail MCP server (pro automatické stažení GoPay vyúčtování z e-mailu) ---
// GMAIL_MCP_URL = veřejná /mcp adresa tvého Gmail MCP serveru.
const GMAIL_MCP_URL = (process.env.GMAIL_MCP_URL || '').trim();
const GMAIL_MCP_ACCOUNT = (process.env.GMAIL_MCP_ACCOUNT || 'varjag.claude@gmail.com').trim();
const GMAIL_MCP_QUERY = (process.env.GMAIL_MCP_QUERY || 'GoPay vyúčtování').trim();
const gmailConfigured = () => Boolean(GMAIL_MCP_URL);

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

// ---- Minimal MCP (Streamable HTTP) client: initialize -> initialized -> tools/call ----
// Handles both application/json and text/event-stream responses. No dependencies.
function mcpHeaders(sid) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (sid) h['Mcp-Session-Id'] = sid;
  return h;
}
async function mcpRead(resp) {
  const ct = resp.headers.get('content-type') || '';
  const text = await resp.text();
  if (ct.includes('text/event-stream')) {
    const msgs = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('data:')) { try { msgs.push(JSON.parse(line.slice(5).trim())); } catch {} }
    }
    return msgs;
  }
  try { return [JSON.parse(text)]; } catch { return []; }
}
async function mcpInit(url) {
  const body = { jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'abo-gpc-viewer', version: '1.0' } } };
  const r = await fetch(url, { method: 'POST', headers: mcpHeaders(''), body: JSON.stringify(body) });
  if (!r.ok && r.status !== 200) throw new Error('MCP initialize HTTP ' + r.status);
  const sid = r.headers.get('mcp-session-id') || r.headers.get('Mcp-Session-Id') || '';
  await mcpRead(r);
  // notifications/initialized (fire and forget)
  try { await fetch(url, { method: 'POST', headers: mcpHeaders(sid), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }); } catch {}
  return sid;
}
async function mcpTool(url, sid, name, args, id) {
  const r = await fetch(url, { method: 'POST', headers: mcpHeaders(sid),
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
  const msgs = await mcpRead(r);
  const resp = msgs.find(m => m && m.id === id) || msgs[msgs.length - 1];
  if (!resp) throw new Error('MCP: prázdná odpověď od nástroje ' + name);
  if (resp.error) throw new Error('MCP ' + name + ': ' + (resp.error.message || 'chyba'));
  const content = (resp.result && resp.result.content) || [];
  const textPart = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  return textPart;
}
const jparse = (s) => { try { return JSON.parse(s); } catch { return null; } };

// Pull GoPay clearing XML attachments from the mailbox via the Gmail MCP server.
async function fetchGopayClearings() {
  const url = GMAIL_MCP_URL, account = GMAIL_MCP_ACCOUNT;
  const sid = await mcpInit(url);
  const listTxt = await mcpTool(url, sid, 'list_emails', { account, query: GMAIL_MCP_QUERY, max_results: 50 }, 2);
  const listData = jparse(listTxt);
  const emails = (Array.isArray(listData) ? listData : [listData]).flatMap(x => (x && x.emails) || []);
  const out = [];
  let id = 10;
  for (const em of emails) {
    const attTxt = await mcpTool(url, sid, 'list_attachments', { account, message_id: em.id }, id++);
    const attData = jparse(attTxt) || {};
    const xmls = (attData.attachments || []).filter(a => /\.xml$/i.test(a.filename || '') || /xml/i.test(a.mimeType || ''));
    for (const a of xmls) {
      const gotTxt = await mcpTool(url, sid, 'get_attachment', { account, message_id: em.id, attachment_id: a.attachmentId }, id++);
      const got = jparse(gotTxt);
      if (got && got.data) out.push({ filename: a.filename, xml: Buffer.from(got.data, 'base64').toString('utf8') });
    }
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/healthz') return send(res, 200, JSONT, '{"ok":true}');

  // GoPay: stav (je nakonfigurovaný MCP most na e-mail?)
  if (path === '/api/gopay/status')
    return send(res, 200, JSONT, JSON.stringify({ configured: gmailConfigured(), tokenRequired: Boolean(APP_TOKEN), account: GMAIL_MCP_ACCOUNT }));

  // GoPay: stáhni clearing XML z e-mailu přes MCP server
  if (path === '/api/gopay/clearings') {
    if (APP_TOKEN && req.headers['x-app-token'] !== APP_TOKEN)
      return send(res, 401, JSONT, JSON.stringify({ error: 'Neplatný nebo chybějící přístupový token.' }));
    if (!gmailConfigured())
      return send(res, 503, JSONT, JSON.stringify({ error: 'Není nastaveno GMAIL_MCP_URL (adresa tvého Gmail MCP serveru).' }));
    try {
      const clearings = await fetchGopayClearings();
      return send(res, 200, JSONT, JSON.stringify({ count: clearings.length, clearings }));
    } catch (e) {
      return send(res, 502, JSONT, JSON.stringify({ error: 'Stažení z e-mailu selhalo: ' + (e.message || e) }));
    }
  }

  // Non-sensitive: lets the UI know whether the backend is ready and gated.
  // Adds structural diagnostics (lengths/shape, never the values) to help spot
  // a swapped key/password or stray whitespace. Gated by token when APP_TOKEN is set.
  if (path === '/api/zasilkovna/status') {
    const authed = !APP_TOKEN || req.headers['x-app-token'] === APP_TOKEN;
    const body = { configured: zasConfigured(), tokenRequired: Boolean(APP_TOKEN) };
    if (authed) {
      body.keyLength = ZAS_KEY.length;
      body.passwordLength = ZAS_PW.length;
      body.keyLooksHex = /^[0-9a-f]+$/i.test(ZAS_KEY);
      body.passwordLooksHex = /^[0-9a-f]+$/i.test(ZAS_PW);
      body.keyEqualsPassword = Boolean(ZAS_KEY) && ZAS_KEY === ZAS_PW;
    }
    return send(res, 200, JSONT, JSON.stringify(body));
  }

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
