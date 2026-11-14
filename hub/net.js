// One HTTP client for every AI call (Claude, OpenAI-compatible providers, voice). Built on Node's
// http/https instead of the built-in fetch, which adds browser-style headers (sec-fetch-mode, a
// wildcard accept-language). Requests carry only what the API needs: auth, content type, and a
// plain server user-agent. No Origin, Referer, Cookie or sec-* headers, ever.
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

export const USER_AGENT = 'Aura-Hub/0.1 (server)';
const BROWSERISH = /^(origin|referer|cookie|accept-language|x-requested-with|anthropic-dangerous-direct-browser-access|sec-.*)$/i;
const keepAlive = { http: new http.Agent({ keepAlive: true }), https: new https.Agent({ keepAlive: true }) };

// The last headers sent to each AI host, with secrets masked, so the Test AI panel can show them.
export const lastSent = new Map();
const mask = (k, v) => /authorization|api-key|x-api-key|xi-api-key/i.test(k) ? v.replace(/(Bearer\s+)?(.{4}).+(.{4})$/i, (_, b = '', a, z) => `${b}${a}…${z}`) : v;

async function toBuffer(body, headers) {
  if (body == null) return null;
  if (typeof body === 'string') return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return Buffer.from(body.buffer ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : body);
  // FormData / Blob / URLSearchParams / streams: let the platform encode it, keep its content type.
  const r = new Request('http://local/', { method: 'POST', body, duplex: 'half' });
  if (!headers.has('content-type') && r.headers.get('content-type')) headers.set('content-type', r.headers.get('content-type'));
  return Buffer.from(await r.arrayBuffer());
}

export async function cleanFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  const body = await toBuffer(init.body ?? null, headers);
  const out = {};
  for (const [k, v] of headers) if (!BROWSERISH.test(k)) out[k] = v;
  if (!out['user-agent'] || /mozilla|applewebkit|chrome|safari/i.test(out['user-agent'])) out['user-agent'] = USER_AGENT;
  out['accept-encoding'] = 'identity';
  if (body) out['content-length'] = String(body.length);
  lastSent.set(url.host, { at: Date.now(), method: init.method || 'GET', path: url.pathname, headers: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, mask(k, v)])) });

  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, { method: init.method || 'GET', headers: out, agent: keepAlive[url.protocol === 'https:' ? 'https' : 'http'] }, res => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) Array.isArray(v) ? v.forEach(x => h.append(k, x)) : v != null && h.set(k, String(v));
      const empty = [101, 204, 205, 304].includes(res.statusCode) || init.method === 'HEAD';
      if (empty) res.resume();
      resolve(new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, statusText: res.statusMessage, headers: h }));
    });
    req.on('error', reject);
    if (init.signal) {
      if (init.signal.aborted) return req.destroy(init.signal.reason || new Error('aborted'));
      init.signal.addEventListener('abort', () => req.destroy(init.signal.reason || new Error('aborted')), { once: true });
    }
    if (body) req.write(body);
    req.end();
  });
}
