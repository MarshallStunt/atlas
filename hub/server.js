// Relay hub: serves the phone UI, signs you in, keeps the device registry, holds the live link
// to each computer's agent, runs the assistant, and writes the audit log.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as auth from './auth.js';
import * as devices from './devices.js';
import * as brain from './brain.js';
import { audit, recentAudit, DATA } from './store.js';

const PORT = Number(process.env.RELAY_PORT || 8100);
const HOST = process.env.RELAY_HOST || '127.0.0.1'; // reach it from the phone through Tailscale Serve, not by opening the port
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...(isJson ? { 'Content-Type': 'application/json' } : {}), ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(new Error('bad JSON')); } });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, 'not found');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found');
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// Browsers send Origin on POSTs; reject ones from other sites (defence in depth on top of SameSite cookies).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    if (o.host === req.headers.host || o.host === req.headers['x-forwarded-host']) return true;
    // Tailscale Serve may forward with Host set to the local address; accept this machine's own tailnet name.
    const tsName = process.env.RELAY_TAILNET_HOST;
    return !!tsName && o.host === tsName;
  } catch { return false; }
}

function state() {
  const id = devices.selectedId();
  return {
    devices: devices.listDevices(),
    snapshot: id ? devices.snapshotOf(id) : null,
    notes: brain.notes().slice(0, 50),
    approvals: brain.pendingApprovals(),
    settings: brain.publicSettings(),
  };
}

// Direct actions from buttons on the dashboard. The user tapped them, so they count as the user's
// own intent; the computer still applies its local policy.
const BUTTON_ACTIONS = new Set(['open_on_computer', 'notify_computer', 'lock_computer', 'view_screen', 'get_overview']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    /* ---- agent endpoints (authenticated by pairing / device signature, not the cookie) ---- */
    if (p === '/agent/pair/request' && req.method === 'POST') return send(res, 200, devices.requestPairing(await readBody(req)));
    if (p === '/agent/pair/poll') return send(res, 200, devices.pollPairing(url.searchParams.get('id')));

    if (!p.startsWith('/api/')) return serveStatic(req, res, p);
    if (req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'cross-site request blocked' });

    /* ---- sign-in ---- */
    const token = auth.tokenFrom(req);
    const authed = auth.check(token);
    if (p === '/api/session') return send(res, 200, { authed, needsSetup: !auth.hasPin(), canSetup: !auth.hasPin() && auth.isDirectLocal(req) });
    if (p === '/api/setup' && req.method === 'POST') {
      if (auth.hasPin()) return send(res, 409, { error: 'A PIN is already set.' });
      if (!auth.isDirectLocal(req)) return send(res, 403, { error: 'Set the PIN from the computer itself (open http://127.0.0.1:' + PORT + ' there).' });
      const { pin } = await readBody(req);
      auth.setPin(pin);
      const t = auth.login(req, pin);
      return send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookieHeader(t, req) });
    }
    if (p === '/api/login' && req.method === 'POST') {
      const { pin } = await readBody(req);
      const t = auth.login(req, pin);
      return send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookieHeader(t, req) });
    }
    if (!authed) return send(res, 401, { error: 'Sign in first.' });
    if (p === '/api/logout' && req.method === 'POST') { auth.logout(token); return send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookieHeader('', req, 0) }); }

    /* ---- dashboard ---- */
    if (p === '/api/state') return send(res, 200, state());
    if (p === '/api/audit') return send(res, 200, recentAudit(100));

    if (p === '/api/devices/pair' && req.method === 'POST') return send(res, 200, devices.approvePairing((await readBody(req)).code));
    let m;
    if ((m = p.match(/^\/api\/devices\/([\w]+)\/(select|revoke)$/)) && req.method === 'POST') {
      m[2] === 'select' ? devices.select(m[1]) : devices.revoke(m[1]);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/action' && req.method === 'POST') {
      const { tool, input = {} } = await readBody(req);
      if (!BUTTON_ACTIONS.has(tool)) return send(res, 400, { error: 'Not a dashboard action.' });
      audit({ who: 'me', via: 'button', event: 'tool', tool, device: devices.selectedId() });
      return send(res, 200, await devices.callDevice(devices.selectedId(), tool, input));
    }

    if (p === '/api/notes' && req.method === 'POST') return send(res, 200, brain.addNote((await readBody(req)).text || ''));
    if ((m = p.match(/^\/api\/notes\/(\w+)$/))) {
      if (req.method === 'DELETE') { brain.deleteNote(m[1]); return send(res, 200, { ok: true }); }
      if (req.method === 'POST') return send(res, 200, brain.setNoteDone(m[1], !!(await readBody(req)).done));
    }

    if (p === '/api/models') return send(res, 200, await brain.listModels(url.searchParams.get('provider')));
    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      brain.setSettings(body);
      audit({ who: 'me', event: 'settings.changed', fields: Object.keys(body), provider: body.provider });
      return send(res, 200, brain.publicSettings());
    }

    /* ---- assistant ---- */
    if (p === '/api/chat/history') return send(res, 200, brain.history());
    if (p === '/api/chat/reset' && req.method === 'POST') { brain.resetConversation(); return send(res, 200, { ok: true }); }
    if ((m = p.match(/^\/api\/approvals\/([\w-]+)$/)) && req.method === 'POST') {
      brain.decide(m[1], !!(await readBody(req)).approve);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/chat' && req.method === 'POST') {
      const { text, tz } = await readBody(req);
      if (!String(text || '').trim()) return send(res, 400, { error: 'Say or type something first.' });
      // Newline-delimited JSON events, streamed as they happen.
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const emit = ev => { if (!res.writableEnded) res.write(JSON.stringify(ev) + '\n'); };
      try { await brain.chat(text, { tz, emit }); emit({ type: 'done' }); }
      catch (e) { emit({ type: 'error', error: friendly(e) }); }
      return res.end();
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 400, { error: friendly(e) });
  }
});

function friendly(e) {
  const msg = String(e?.message || e);
  if (/Could not resolve authentication|apiKey|x-api-key|authentication_error/i.test(msg)) return 'No Claude API key yet. Add one in Devices → Assistant.';
  return msg.slice(0, 400);
}

devices.attach(server);
server.listen(PORT, HOST, () => {
  console.log(`Relay hub on http://${HOST}:${PORT}  (data in ${DATA})`);
  if (!auth.hasPin()) console.log(`First run: open http://127.0.0.1:${PORT} on this computer to set your PIN.`);
});
