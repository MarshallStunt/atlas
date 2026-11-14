// Device registry, pairing (device-code flow) and the live link to each computer's agent.
//
// Pairing: the agent generates an Ed25519 key pair, asks the hub for a short code, and shows it.
// The signed-in user types that code into the dashboard, which binds the agent's public key to
// their account. From then on the agent proves who it is by signing a fresh challenge on every
// connection, so the hub always knows which computer is talking and who owns it.
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { load, save, audit } from './store.js';

const OWNER = 'me'; // single-user for now; becomes the SSO identity when the hub is multi-user
const PAIR_TTL = 10 * 60 * 1000;
const CALL_TIMEOUT = 90 * 1000;

let registry = load('devices.json', { devices: [], selected: null });
const pending = new Map();   // requestId -> { code, publicKey, name, platform, expires, deviceId? }
const live = new Map();      // deviceId -> { ws, snapshot, connectedAt }
const calls = new Map();     // callId -> { resolve, reject, timer }
const listeners = new Set(); // callbacks for device/snapshot changes

const persist = () => save('devices.json', registry);
const emit = () => listeners.forEach(fn => { try { fn(); } catch {} });
export const onChange = fn => listeners.add(fn);

const newCode = () => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  const pick = () => Array.from(crypto.randomBytes(3), b => abc[b % abc.length]).join('');
  return `${pick()}-${pick()}`;
};

/* ---------------- pairing ---------------- */
export function requestPairing({ publicKey, name, platform }) {
  if (typeof publicKey !== 'string' || !publicKey.includes('BEGIN PUBLIC KEY')) throw new Error('bad public key');
  crypto.createPublicKey(publicKey); // throws if malformed
  for (const [id, p] of pending) if (p.expires < Date.now()) pending.delete(id);
  if (pending.size > 20) throw new Error('too many pending pairings');
  const requestId = crypto.randomUUID();
  const code = newCode();
  pending.set(requestId, { code, publicKey, name: String(name || 'Computer').slice(0, 60), platform: String(platform || '').slice(0, 20), expires: Date.now() + PAIR_TTL });
  return { requestId, code, expiresIn: PAIR_TTL / 1000 };
}

export function pollPairing(requestId) {
  const p = pending.get(requestId);
  if (!p) return { status: 'expired' };
  if (p.deviceId) { pending.delete(requestId); return { status: 'approved', deviceId: p.deviceId }; }
  if (p.expires < Date.now()) { pending.delete(requestId); return { status: 'expired' }; }
  return { status: 'waiting' };
}

export function approvePairing(code) {
  const want = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  for (const p of pending.values()) {
    if (p.expires < Date.now() || p.deviceId) continue;
    if (p.code.replace('-', '') !== want) continue;
    const device = { id: 'dev_' + crypto.randomBytes(8).toString('hex'), owner: OWNER, name: p.name, platform: p.platform, publicKey: p.publicKey, pairedAt: new Date().toISOString(), lastSeen: null };
    registry.devices.push(device);
    registry.selected ||= device.id;
    persist();
    p.deviceId = device.id;
    audit({ who: OWNER, event: 'device.paired', device: device.id, name: device.name });
    emit();
    return publicDevice(device);
  }
  throw new Error('That code is wrong or expired. Run the agent again to get a new one.');
}

export function revoke(id) {
  const d = registry.devices.find(x => x.id === id && x.owner === OWNER);
  if (!d) throw new Error('no such device');
  registry.devices = registry.devices.filter(x => x !== d);
  if (registry.selected === id) registry.selected = registry.devices[0]?.id || null;
  persist();
  live.get(id)?.ws.close(4001, 'revoked');
  live.delete(id);
  audit({ who: OWNER, event: 'device.revoked', device: id, name: d.name });
  emit();
}

export function select(id) {
  if (!registry.devices.some(d => d.id === id && d.owner === OWNER)) throw new Error('no such device');
  registry.selected = id; persist(); emit();
}

const publicDevice = d => ({
  id: d.id, name: d.name, platform: d.platform, pairedAt: d.pairedAt, lastSeen: live.has(d.id) ? new Date().toISOString() : d.lastSeen,
  online: live.has(d.id), selected: registry.selected === d.id,
});
export const listDevices = () => registry.devices.filter(d => d.owner === OWNER).map(publicDevice);
export const selectedId = () => registry.selected;
export const snapshotOf = id => live.get(id)?.snapshot || load(`snapshot-${id}.json`, null);

/* ---------------- calling the device ---------------- */
// Ownership is checked on every call: a device only ever receives calls for its own owner.
export function callDevice(deviceId, tool, input = {}) {
  const d = registry.devices.find(x => x.id === deviceId && x.owner === OWNER);
  if (!d) return Promise.reject(new Error('No computer is paired yet.'));
  const link = live.get(deviceId);
  if (!link) return Promise.reject(new Error(`${d.name} is offline (the Aura agent isn't connected).`));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { calls.delete(id); reject(new Error(`${d.name} didn't answer in time.`)); }, CALL_TIMEOUT);
    calls.set(id, { resolve, reject, timer });
    link.ws.send(JSON.stringify({ type: 'call', id, tool, input }));
  });
}

/* ---------------- the agent's WebSocket ---------------- */
export function attach(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 12 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/agent/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => handshake(ws, url.searchParams.get('device')));
  });
}

function handshake(ws, deviceId) {
  const device = registry.devices.find(d => d.id === deviceId);
  if (!device) { ws.close(4001, 'unknown device'); return; }
  const nonce = crypto.randomBytes(32).toString('base64');
  let authed = false;
  const giveUp = setTimeout(() => authed || ws.close(4002, 'auth timeout'), 10000);
  ws.send(JSON.stringify({ type: 'challenge', nonce }));

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (!authed) {
      if (msg.type !== 'auth') return ws.close(4002, 'auth first');
      let ok = false;
      try { ok = crypto.verify(null, Buffer.from(`aura:${deviceId}:${nonce}`), crypto.createPublicKey(device.publicKey), Buffer.from(String(msg.sig), 'base64')); } catch {}
      if (!ok) { audit({ event: 'device.auth_failed', device: deviceId }); return ws.close(4003, 'bad signature'); }
      authed = true; clearTimeout(giveUp);
      live.get(deviceId)?.ws.close(4004, 'replaced by a newer connection');
      live.set(deviceId, { ws, snapshot: snapshotOf(deviceId), connectedAt: Date.now() });
      ws.send(JSON.stringify({ type: 'welcome', name: device.name }));
      emit();
      return;
    }
    if (msg.type === 'snapshot') {
      const link = live.get(deviceId);
      if (link?.ws === ws) { link.snapshot = { ...msg.data, receivedAt: Date.now() }; save(`snapshot-${deviceId}.json`, link.snapshot); }
      emit();
    } else if (msg.type === 'result') {
      const c = calls.get(msg.id);
      if (!c) return;
      calls.delete(msg.id); clearTimeout(c.timer);
      msg.ok ? c.resolve(msg.result) : c.reject(new Error(msg.error || 'failed on the computer'));
    }
  });
  ws.on('close', () => {
    clearTimeout(giveUp);
    if (live.get(deviceId)?.ws === ws) {
      live.delete(deviceId);
      device.lastSeen = new Date().toISOString(); persist();
      emit();
    }
  });
  ws.on('error', () => {});
}
