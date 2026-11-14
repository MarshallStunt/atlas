// Aura agent: runs on the work computer as the signed-in user (never as root/admin).
// - Pairs once with the hub and keeps an Ed25519 device key in ~/.aura-agent (owner-only).
// - Dials OUT to the hub over a WebSocket, so the computer never opens a port to the network.
// - Checks its own local policy before every action, whatever the hub asks.
// - Serves a local-only page (127.0.0.1:8101) where the person at the computer sets that policy,
//   and the endpoints the Chrome bridge uses to hand over Gmail / Calendar / Slack.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POLICY_DEFAULTS, TOOL_POLICY, status, makeTools, APPS, appOf, urlAllowed, matcherFor, cleanLink } from './capabilities.js';

const DATA = process.env.AURA_AGENT_DATA || path.join(os.homedir(), '.aura-agent');
const LOCAL_PORT = Number(process.env.AURA_AGENT_PORT || 8101);
fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
const f = n => path.join(DATA, n);
const readJson = (n, d) => { try { return JSON.parse(fs.readFileSync(f(n), 'utf8')); } catch { return d; } };
const writeJson = (n, v) => fs.writeFileSync(f(n), JSON.stringify(v, null, 2), { mode: 0o600 });
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const audit = e => fs.appendFileSync(f('audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n', { mode: 0o600 });

const argHub = process.argv.find(a => a.startsWith('--hub='))?.slice(6);
let device = readJson('device.json', null);
const hubUrl = (argHub || device?.hubUrl || process.env.AURA_HUB || 'http://127.0.0.1:8100').replace(/\/$/, '');

/* ---------------- local policy ---------------- */
function policy() {
  const saved = readJson('policy.json', {});
  return Object.fromEntries(Object.entries(POLICY_DEFAULTS).map(([k, v]) => [k, { ...v, on: k in saved ? !!saved[k] : v.on }]));
}
const allowed = key => policy()[key]?.on;

/* ---------------- spaces: one per browser (e.g. Work in Chrome, Personal in Edge) ----------------
   Each browser's extension is its own space with its own data, app choices and jobs, so a personal
   Gmail never overwrites a work one, and actions go to the browser they belong to. */
const CORE = { gmail: 'gmail', calendar: 'gcal', slack: 'slack', outlook: 'outlook' }; // inbox key -> app id
// The extension version shipped with this agent; the extension reloads itself when it's older.
const BRIDGE_VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'bridge', 'manifest.json'), 'utf8')).version; } catch { return null; } })();
const sp = (id, n) => path.join('spaces', id, n);
fs.mkdirSync(f('spaces'), { recursive: true, mode: 0o700 });

let spaces = readJson('spaces.json', null);
if (!spaces) {
  // First run with spaces: everything that existed becomes the "Work" space (same token, data, choices).
  const legacyToken = fs.existsSync(f('bridge-token')) ? fs.readFileSync(f('bridge-token'), 'utf8').trim() : '';
  spaces = { list: [{ id: 'work', name: 'Work', origin: null, token: legacyToken || crypto.randomBytes(18).toString('base64url'), browser: readJson('browser.json', {}).app || 'Google Chrome', private: false }] };
  fs.mkdirSync(f(path.join('spaces', 'work')), { recursive: true, mode: 0o700 });
  for (const n of ['inbox.json', 'apps.json']) if (fs.existsSync(f(n))) fs.copyFileSync(f(n), f(sp('work', n)));
  writeJson('spaces.json', spaces);
}
const saveSpaces = () => writeJson('spaces.json', spaces);
const rt = {}; // runtime per space: { inbox, seen, poller, jobs, lastLaunch }
const R = id => (rt[id] ||= { inbox: readJson(sp(id, 'inbox.json'), null), seen: 0, poller: null, jobs: [], lastLaunch: 0 });
const jobWaiters = new Map(); // job id -> { resolve, reject, timer }
const spaceById = id => spaces.list.find(s => s.id === id);
const findSpace = key => { const k = String(key || '').toLowerCase(); return spaces.list.find(s => s.id === k || s.name.toLowerCase() === k) || null; };
const connectedNow = s => Date.now() - R(s.id).seen < 90 * 1000;

/* ---------------- app choices, per space ---------------- */
function appChoices(id = spaces.list[0].id) {
  const saved = readJson(sp(id, 'apps.json'), {});
  return { apps: Object.fromEntries(APPS.map(a => [a.id, saved.apps?.[a.id] ?? a.def !== false])), otherSites: saved.otherSites !== false, outlookMailUrl: saved.outlookMailUrl || '', outlookCalUrl: saved.outlookCalUrl || '' };
}
// What a space's browser extension needs to know: which apps to sync and which sites it may read.
const bridgeConfig = id => { const c = appChoices(id); return { space: spaceById(id)?.name, bridgeVersion: BRIDGE_VERSION, apps: c.apps, otherSites: c.otherSites, outlook: { mail: c.outlookMailUrl, calendar: c.outlookCalUrl }, matchers: Object.fromEntries(APPS.map(a => [a.id, matcherFor(a, c)])) }; };
function answerPoll(id, jobs = []) {
  const r = R(id); if (!r.poller) return false;
  const { res, timer } = r.poller; r.poller = null; clearTimeout(timer);
  json(res, 200, { jobs, config: bridgeConfig(id) }); return true;
}

// Which space a request is for: the one named, else the one that has that site open, else the
// first connected non-private one.
function pickSpace(input = {}, kind) {
  const pool = input._public ? spaces.list.filter(x => !x.private) : spaces.list; // hub says: not private ones
  if (input.space) { const s = findSpace(input.space); if (!s) throw new Error(`There's no space called "${input.space}". Spaces: ${spaces.list.map(x => x.name).join(', ')}.`); return s; }
  if (kind === 'slack_send') { const s = pool.find(x => connectedNow(x) && R(x.id).inbox?.slack && appChoices(x.id).apps.slack); if (s) return s; }
  if (input.url) { try { const host = new URL(input.url).host; const s = pool.find(x => connectedNow(x) && (R(x.id).inbox?.tabs || []).some(t => String(t.url).includes(host))); if (s) return s; } catch {} }
  const s = pool.find(x => connectedNow(x) && !x.private) || pool.find(connectedNow) || pool[0];
  if (!s) throw new Error('No space is available for this.');
  return s;
}

// Hand a job to a space's browser extension and wait for its answer.
function browser(kind, input = {}) {
  let s; try { s = pickSpace(input, kind); } catch (e) { return Promise.reject(e); }
  const { space, _public, ...rest } = input;
  const ch = appChoices(s.id);
  if (kind === 'read' && rest.url) { const v = urlAllowed(rest.url, ch); if (!v.ok) return Promise.reject(new Error(v.reason)); }
  if (kind === 'slack_send' && ch.apps.slack === false) return Promise.reject(new Error(`Slack is turned off for the ${s.name} space (System → Apps).`));
  if (!connectedNow(s)) return Promise.reject(new Error(`The ${s.name} browser (${s.browser}) isn't connected. Open it with the Aura Bridge extension installed.`));
  const job = { id: crypto.randomUUID(), kind, input: rest };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { jobWaiters.delete(job.id); reject(new Error(`The ${s.name} browser didn't answer in time.`)); }, 60000);
    jobWaiters.set(job.id, { resolve: v => resolve(v && typeof v === 'object' ? { space: s.name, ...v } : v), reject, timer, space: s.id });
    R(s.id).jobs.push(job);
    flushJobs(s.id);
  });
}
function flushJobs(id) { const r = R(id); if (r.poller && r.jobs.length) answerPoll(id, r.jobs.splice(0)); }

function overviewSpace(id) {
  const inbox = R(id).inbox;
  if (!inbox) return { connected: false, note: 'This browser has not sent anything yet.' };
  const now = Date.now();
  const ch = appChoices(id);
  const on = key => ch.apps[CORE[key]] !== false;
  const events = (inbox.calendar?.events || []).filter(e => !e.at || (e.at > now - 3600e3 && e.at < now + 36 * 3600e3)).slice(0, 20);
  return {
    connected: now - (inbox.receivedAt || 0) < 10 * 60 * 1000, updated: new Date(inbox.receivedAt).toISOString(),
    calendar: on('calendar') && inbox.calendar ? { email: inbox.calendar.email, events } : null,
    gmail: on('gmail') && inbox.gmail ? { email: inbox.gmail.email, unread: inbox.gmail.unread, latest: (inbox.gmail.entries || []).slice(0, 15) } : null,
    outlook: on('outlook') && inbox.outlook ? { who: inbox.outlook.who, unread: inbox.outlook.unread, latest: (inbox.outlook.entries || []).slice(0, 15),
      events: (inbox.outlook.events || []).filter(e => !e.at || (e.at > now - 3600e3 && e.at < now + 4 * 864e5)).slice(0, 30), calendarError: inbox.outlook.calendarError || null,
      ...(inbox.outlook.raw ? { raw: inbox.outlook.raw } : {}), ...(inbox.outlook.calendarRaw ? { calendarRaw: inbox.outlook.calendarRaw } : {}) } : null,
    slack: on('slack') && inbox.slack ? { team: inbox.slack.team, mentions: (inbox.slack.mentions || []).filter(m => m.at > now - 48 * 3600e3).slice(0, 15) } : null,
    openTabs: (inbox.tabs || []).filter(t => urlAllowed(t.url, ch).ok).slice(0, 30),
    errors: Object.fromEntries(Object.entries(inbox.errors || {}).filter(([k]) => !CORE[k] || on(k))),
  };
}
const extFolder = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'Aura', 'extension') : path.join(os.homedir(), '.aura', 'extension');
function spaceSummary(s) {
  const r = R(s.id), ch = appChoices(s.id);
  return {
    id: s.id, name: s.name, private: !!s.private, browser: s.browser, connected: connectedNow(s),
    inbox: overviewSpace(s.id),
    apps: { otherSites: ch.otherSites, outlookMailUrl: ch.outlookMailUrl, outlookCalUrl: ch.outlookCalUrl, list: APPS.map(a => ({ id: a.id, name: a.name, kind: a.kind, synced: !!a.synced, on: ch.apps[a.id] })) },
    bridge: { lastSync: r.inbox?.receivedAt || null, lastPoll: r.seen || null, extension: s.origin || null, version: r.inbox?.version || null, expected: BRIDGE_VERSION, folder: extFolder },
  };
}

async function overview() {
  const p = policy();
  const list = p.browser_read.on ? spaces.list.map(spaceSummary) : [];
  const main = list.find(x => !x.private) || list[0];
  return {
    takenAt: new Date().toISOString(),
    computer: p.status.on ? await status() : { note: 'Status is switched off on this computer.' },
    capabilities: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.on])),
    spaces: list,
    // Older hubs read these: the main (first non-private) space.
    inbox: p.browser_read.on ? (main?.inbox || { connected: false }) : { note: 'Reading web apps is switched off on this computer.' },
    apps: main?.apps, bridge: main?.bridge,
  };
}

const tools = makeTools({ overview, browser });

/* ---------------- automatic reconnection ----------------
   If a space's browser goes quiet (closed, crashed, asleep), start that browser again in the
   background. Its extension then wakes its app tabs and syncs by itself. */
function browserRunning(app) {
  if (process.platform === 'win32') return false;
  try { return execFileSync('pgrep', ['-f', app], { stdio: ['ignore', 'pipe', 'ignore'] }).length > 0; } catch { return false; }
}
function launchBrowser(s, reason) {
  const r = R(s.id);
  if (browserRunning(s.browser)) return { launched: false, note: `${s.browser} (${s.name}) is open but its Aura extension isn't answering. Reload Aura Bridge there, or load it from ${extFolder}.` };
  if (Date.now() - r.lastLaunch < 10 * 60 * 1000) return { launched: false, note: `Started ${s.browser} a few minutes ago; waiting for it.` };
  r.lastLaunch = Date.now();
  const exe = { 'Google Chrome': ['chrome', 'google-chrome'], 'Microsoft Edge': ['msedge', 'microsoft-edge'], 'Brave Browser': ['brave', 'brave-browser'], Opera: ['opera', 'opera'] }[s.browser] || ['chrome', 'google-chrome'];
  const [cmd, args] = process.platform === 'darwin' ? ['open', ['-g', '-a', s.browser]]
    : process.platform === 'win32' ? ['cmd.exe', ['/d', '/c', 'start', '', '/min', exe[0]]]
    : [exe[1], []];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (e) { return { launched: false, note: 'Could not start the browser: ' + e.message }; }
  audit({ event: 'reconnect.browser_started', space: s.name, browser: s.browser, reason });
  log(`${s.name}: browser extension was quiet; started ${s.browser} in the background (${reason}).`);
  return { launched: true, note: `Started ${s.browser} in the background; the ${s.name} space reconnects within a minute.` };
}
setInterval(() => {
  if (!allowed('browser_read')) return;
  for (const s of spaces.list) if (Date.now() - R(s.id).seen > 3 * 60 * 1000 && (s.origin || R(s.id).inbox)) launchBrowser(s, 'watchdog');
}, 60 * 1000);

// Double-check the extension's answers against that space's app choices before anything reaches the hub.
tools.browser_tabs = async (input = {}) => {
  const targets = input.space ? [findSpace(input.space)].filter(Boolean) : spaces.list.filter(x => connectedNow(x) && !(input._public && x.private));
  const out = [];
  for (const s of targets) { try { const r = await browser('tabs', { space: s.id }); const ch = appChoices(s.id); out.push(...(r?.tabs || []).filter(t => urlAllowed(t.url, ch).ok).map(t => ({ ...t, space: s.name }))); } catch {} }
  return { tabs: out };
};
const readTool = tools.browser_read, actTool = tools.browser_act;
const spaceOfResult = r => findSpace(r?.space) || spaces.list[0];
tools.browser_read = async input => { const r = await readTool(input); const v = urlAllowed(r?.url, appChoices(spaceOfResult(r).id)); if (!v.ok) throw new Error(v.reason); return r; };
tools.browser_act = async input => { const r = await actTool(input); const v = urlAllowed(r?.after?.url, appChoices(spaceOfResult(r).id)); if (!v.ok) throw new Error(v.reason); return r; };

// Choosing apps for a space (System → Apps on the phone). Applies at once.
tools.set_apps = async ({ space, apps = {}, otherSites, outlookMailUrl, outlookCalUrl } = {}) => {
  const s = space ? findSpace(space) : spaces.list[0];
  if (!s) throw new Error('No such space.');
  const cur = appChoices(s.id);
  if (outlookMailUrl !== undefined) cur.outlookMailUrl = cleanLink(outlookMailUrl);
  if (outlookCalUrl !== undefined) cur.outlookCalUrl = cleanLink(outlookCalUrl);
  for (const [id, on] of Object.entries(apps)) if (APPS.some(a => a.id === id)) cur.apps[id] = !!on;
  if (typeof otherSites === 'boolean') cur.otherSites = otherSites;
  fs.mkdirSync(f(path.join('spaces', s.id)), { recursive: true, mode: 0o700 });
  writeJson(sp(s.id, 'apps.json'), cur);
  audit({ event: 'apps.changed', space: s.name, apps: cur.apps, otherSites: cur.otherSites });
  log(`${s.name}: apps off = ` + (Object.entries(cur.apps).filter(([, v]) => !v).map(([k]) => k).join(', ') || 'none'));
  answerPoll(s.id); // tell that browser now
  pushSnapshot();
  return { ok: true, space: s.name, ...cur };
};

// Rename a space, make it private, or remove it (its browser can connect again as a new space).
tools.set_space = async ({ space, name, private: priv, remove } = {}) => {
  const s = findSpace(space);
  if (!s) throw new Error('No such space.');
  if (remove) {
    if (spaces.list.length === 1) throw new Error('Keep at least one space.');
    spaces.list = spaces.list.filter(x => x !== s); saveSpaces();
    answerPoll(s.id); delete rt[s.id];
    fs.rmSync(f(path.join('spaces', s.id)), { recursive: true, force: true });
    audit({ event: 'space.removed', space: s.name }); pushSnapshot();
    return { ok: true, removed: s.name };
  }
  if (typeof name === 'string') {
    const n = name.trim().slice(0, 24);
    if (!n) throw new Error('Give the space a name.');
    if (spaces.list.some(x => x !== s && x.name.toLowerCase() === n.toLowerCase())) throw new Error('Another space already has that name.');
    s.name = n;
  }
  if (typeof priv === 'boolean') s.private = priv;
  saveSpaces(); audit({ event: 'space.changed', space: s.name, private: s.private }); pushSnapshot();
  return { ok: true, id: s.id, name: s.name, private: s.private };
};

tools.reconnect = async () => {
  if (!allowed('browser_read')) return { ok: false, note: 'Reading web apps is switched off on this computer.' };
  const notes = [];
  for (const s of spaces.list) {
    if (Date.now() - R(s.id).seen > 3 * 60 * 1000) { if (s.origin || R(s.id).inbox) notes.push(launchBrowser(s, 'requested from the phone').note); }
    else { try { await browser('resync', { space: s.id }); notes.push(`${s.name}: resynced.`); } catch (e) { notes.push(`${s.name}: ${e.message}`); } }
  }
  return { ok: true, note: notes.join(' ') || 'Nothing to reconnect.' };
};

async function handleCall({ id, tool, input }) {
  const key = TOOL_POLICY[tool];
  let reply;
  if (!key || !tools[tool]) reply = { ok: false, error: `Unknown action ${tool}.` };
  else if (!allowed(key)) reply = { ok: false, error: `"${POLICY_DEFAULTS[key].label}" is switched off on this computer. It can be turned on from the Aura agent page on the computer (http://127.0.0.1:${LOCAL_PORT}).` };
  else {
    try { reply = { ok: true, result: await tools[tool](input || {}) }; }
    catch (e) { reply = { ok: false, error: String(e.message || e) }; }
  }
  audit({ event: 'call', tool, ok: reply.ok, error: reply.error, input: ['run_command', 'slack_send', 'browser_act'].includes(tool) ? input : undefined });
  log(`${tool} → ${reply.ok ? 'ok' : 'refused/failed: ' + reply.error}`);
  return { type: 'result', id, ...reply };
}

/* ---------------- pairing ---------------- */
async function pair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const name = (os.hostname().replace(/\.local$/, '') || 'Computer');
  const r = await fetch(hubUrl + '/agent/pair/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publicKey: pub, name, platform: process.platform }) });
  if (!r.ok) throw new Error('Hub refused pairing: ' + await r.text());
  const { requestId, code, expiresIn } = await r.json();
  console.log(`\n  Pair this computer: open Aura on your phone → Devices → Pair, and enter\n\n        ${code}\n\n  (expires in ${Math.round(expiresIn / 60)} minutes)\n`);
  pairingCode = code;
  for (;;) {
    await new Promise(res => setTimeout(res, 2000));
    const s = await (await fetch(hubUrl + '/agent/pair/poll?id=' + encodeURIComponent(requestId))).json();
    if (s.status === 'approved') {
      device = { deviceId: s.deviceId, hubUrl, name, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
      writeJson('device.json', device);
      pairingCode = null;
      log(`Paired as ${name} (${s.deviceId}).`);
      return;
    }
    if (s.status === 'expired') { pairingCode = null; throw new Error('Pairing code expired. Start the agent again for a new one.'); }
  }
}
let pairingCode = null;

/* ---------------- link to the hub ---------------- */
let ws = null, connected = false, backoff = 1000;
function connect() {
  const wsUrl = hubUrl.replace(/^http/, 'ws') + '/agent/ws?device=' + encodeURIComponent(device.deviceId);
  ws = new WebSocket(wsUrl, { maxPayload: 4 * 1024 * 1024 });
  ws.on('message', async raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'challenge') {
      const sig = crypto.sign(null, Buffer.from(`aura:${device.deviceId}:${msg.nonce}`), crypto.createPrivateKey(device.privateKey)).toString('base64');
      ws.send(JSON.stringify({ type: 'auth', sig }));
    } else if (msg.type === 'welcome') {
      connected = true; backoff = 1000; log(`Connected to hub ${hubUrl} as ${msg.name}.`);
      pushSnapshot();
    } else if (msg.type === 'call') {
      ws.send(JSON.stringify(await handleCall(msg)));
    }
  });
  ws.on('close', (code, reason) => {
    connected = false;
    if (code === 4001 || code === 4003) {
      log(`Hub no longer recognises this computer (${reason}). Removing the pairing; restart the agent to pair again.`);
      fs.rmSync(f('device.json'), { force: true });
      process.exit(1);
    }
    setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30000);
  });
  ws.on('error', e => { if (backoff <= 2000) log('Hub not reachable yet:', e.message); });
}

let pushing = false, pushAgain = false;
async function pushSnapshot() {
  if (!connected) return;
  if (pushing) { pushAgain = true; return; } // a change came in mid-push: send a fresh one right after
  pushing = true;
  try { ws.send(JSON.stringify({ type: 'snapshot', data: await overview() })); }
  catch (e) { log('snapshot failed:', e.message); }
  finally { pushing = false; if (pushAgain) { pushAgain = false; pushSnapshot(); } }
}

/* ---------------- local page + bridge endpoints (127.0.0.1 only) ---------------- */
const csrf = crypto.randomBytes(18).toString('base64url');
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > 2e6) req.destroy(); else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch (e) { reject(e); } });
  });
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page() {
  const p = policy();
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aura agent</title>
<style>:root{color-scheme:light dark;--bg:#0b0d12;--card:#141821;--line:#262c39;--text:#e8ecf3;--dim:#8b93a7;--accent:#5eead4}
@media (prefers-color-scheme:light){:root{--bg:#f5f6f8;--card:#fff;--line:#e1e4ea;--text:#141821;--dim:#5b6475;--accent:#0f9488}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,system-ui,sans-serif}main{max-width:640px;margin:0 auto;padding:24px 16px}
h1{font-size:20px;margin:0 0 4px}.dim{color:var(--dim)}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}
label{display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--line)}label:first-of-type{border-top:0}input{margin-top:4px;width:18px;height:18px;accent-color:var(--accent)}
code{background:var(--bg);padding:2px 6px;border-radius:6px;word-break:break-all}.ok{color:var(--accent)}.code{font:600 28px ui-monospace,monospace;letter-spacing:.1em}</style></head><body><main>
<h1>Aura agent on ${esc(os.hostname())}</h1><div class="dim">This page only opens on this computer. Switches here can't be changed from the phone.</div>
<div class="card"><b>Hub:</b> ${esc(hubUrl)} — ${device ? (connected ? '<span class="ok">connected</span>' : 'not connected') : pairingCode ? `waiting to pair. Enter this code on your phone:<div class="code">${pairingCode}</div>` : 'not paired'}</div>
<div class="card"><b>What Aura may do on this computer</b>
<form id="f">${Object.entries(p).map(([k, v]) => `<label><input type="checkbox" name="${k}" ${v.on ? 'checked' : ''}><span><b>${esc(v.label)}</b><br><span class="dim">${esc(v.detail)}</span></span></label>`).join('')}</form>
<div id="saved" class="dim"></div></div>
<div class="card"><b>Browsers (spaces)</b>
${spaces.list.map(sx => { const r = R(sx.id); const ib = overviewSpace(sx.id); return `<p><b>${esc(sx.name)}</b>${sx.private ? ' (private)' : ''} · ${esc(sx.browser)} — ${connectedNow(sx) ? '<span class="ok">connected</span>' : 'not connected'}${r.inbox ? ` <span class="dim">(last update ${esc(new Date(r.inbox.receivedAt).toLocaleTimeString())})</span>` : ''}</p>${Object.entries(ib.errors || {}).map(([k, v]) => `<p class="dim">${esc(k)}: ${esc(v)}</p>`).join('')}`; }).join('')}
<p class="dim">Add a space by installing the Aura Bridge extension in another browser or browser profile (load it from <code>${esc(extFolder)}</code>). It connects by itself as a new space you can rename in Aura.</p></div>
<script>document.getElementById('f').addEventListener('change',async()=>{const fd=new FormData(document.getElementById('f'));const body={};${JSON.stringify(Object.keys(p))}.forEach(k=>body[k]=fd.has(k));
const r=await fetch('/policy',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF':${JSON.stringify(csrf)}},body:JSON.stringify(body)});document.getElementById('saved').textContent=r.ok?'Saved.':'Could not save.';});</script>
</main></body></html>`;
}

const local = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const isBridge = url.pathname.startsWith('/bridge/');
  try {
    // The extension fetches the token itself. Only a browser extension can send a chrome-extension:// or
    // moz-extension:// Origin (web pages can't fake it, and they can't read this answer anyway: no CORS).
    if (url.pathname === '/bridge/hello' && req.method === 'POST') {
      const origin = String(req.headers.origin || '');
      if (!/^(chrome|moz|edge)-extension:\/\/[a-z0-9-]+$/i.test(origin)) return json(res, 403, { error: 'extensions only' });
      if (!allowed('browser_read') && !allowed('browser_act')) return json(res, 403, { error: 'browser access is switched off on this computer' });
      let b = {}; try { b = await body(req); } catch {}
      const browserName = /^[A-Za-z ]{3,30}$/.test(b.browser || '') ? b.browser : 'Browser';
      // Find this browser's space by its install ID (the extension ID is the same in every browser that
      // loads it from the same folder). A space from before install IDs can only be claimed by the same
      // kind of browser it came from; anything else becomes a new space.
      const iid = /^[0-9a-f-]{36}$/i.test(b.installId || '') ? b.installId : null;
      let s = (iid && spaces.list.find(x => x.installId === iid)) || spaces.list.find(x => !x.installId && !x.claimed && x.browser === browserName);
      if (!s) {
        const base = browserName.replace(/^Google /, '').replace(/^Microsoft /, '').replace(/ Browser$/, '');
        let name = base, n = 2; while (spaces.list.some(x => x.name.toLowerCase() === name.toLowerCase())) name = `${base} ${n++}`;
        s = { id: crypto.randomBytes(5).toString('hex'), name, origin, installId: iid, claimed: true, token: crypto.randomBytes(18).toString('base64url'), browser: browserName, private: false };
        spaces.list.push(s);
        fs.mkdirSync(f(path.join('spaces', s.id)), { recursive: true, mode: 0o700 });
        log(`New space "${name}" from ${browserName}.`);
      }
      s.origin = origin; s.browser = browserName; s.claimed = true; if (iid) s.installId = iid; saveSpaces();
      audit({ event: 'bridge.hello', extension: origin, space: s.name });
      pushSnapshot();
      return json(res, 200, { token: s.token, space: s.name });
    }
    if (isBridge) {
      const given = String(req.headers['x-aura-bridge'] || '');
      const s = spaces.list.find(x => x.token.length === given.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(x.token)));
      if (!s) return json(res, 401, { error: 'bad bridge token' });
      const r = R(s.id);
      if (url.pathname === '/bridge/ingest' && req.method === 'POST') {
        const b = await body(req);
        r.inbox = { ...(r.inbox || {}), ...b, errors: b.errors || {}, receivedAt: Date.now() };
        writeJson(sp(s.id, 'inbox.json'), r.inbox);
        pushSnapshot();
        return json(res, 200, { ok: true, config: bridgeConfig(s.id) });
      }
      if (url.pathname === '/bridge/jobs') {
        r.seen = Date.now();
        answerPoll(s.id);
        const timer = setTimeout(() => { if (r.poller?.res === res) answerPoll(s.id); }, 25000);
        r.poller = { res, timer };
        req.on('close', () => { if (r.poller?.res === res) { clearTimeout(timer); r.poller = null; } });
        return flushJobs(s.id);
      }
      if (url.pathname === '/bridge/result' && req.method === 'POST') {
        const b = await body(req);
        const w = jobWaiters.get(b.id);
        if (w && w.space === s.id) { jobWaiters.delete(b.id); clearTimeout(w.timer); b.ok ? w.resolve(b.result) : w.reject(new Error(b.error || 'The browser action failed')); }
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'not found' });
    }
    // The policy page: only for someone at this computer, never proxied, never cross-site.
    if (req.headers['x-forwarded-for'] || req.headers.forwarded) return json(res, 403, { error: 'local only' });
    if (url.pathname === '/' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" }); return res.end(page()); }
    if (url.pathname === '/policy' && req.method === 'POST') {
      if (req.headers['x-csrf'] !== csrf || (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${LOCAL_PORT}`)) return json(res, 403, { error: 'forbidden' });
      const b = await body(req);
      const saved = Object.fromEntries(Object.keys(POLICY_DEFAULTS).map(k => [k, !!b[k]]));
      writeJson('policy.json', saved);
      audit({ event: 'policy.changed', policy: saved });
      log('Policy changed:', Object.entries(saved).filter(([, v]) => v).map(([k]) => k).join(', ') || '(everything off)');
      pushSnapshot();
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
});

/* ---------------- start ---------------- */
if (!process.argv.includes('--pair-only')) local.listen(LOCAL_PORT, '127.0.0.1', () => log(`Agent page: http://127.0.0.1:${LOCAL_PORT}`));
(async () => {
  try {
    if (!device || (argHub && device.hubUrl !== hubUrl)) await pair();
    if (process.argv.includes('--pair-only')) { console.log('Paired. The background service will connect from now on.'); process.exit(0); }
    connect();
    setInterval(pushSnapshot, 60000);
  } catch (e) { console.error(e.message); process.exit(1); }
})();
