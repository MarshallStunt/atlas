// Single-user sign-in: a PIN set once from the computer itself, then session cookies.
// When the hub becomes multi-user this is the piece that gets replaced by company SSO.
import crypto from 'node:crypto';
import { load, save, audit } from './store.js';

const SESSION_DAYS = 30;
let auth = load('auth.json', { pin: null, sessions: {} });
const attempts = new Map(); // ip -> { count, until }

const hash = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
const persist = () => save('auth.json', auth);

export const hasPin = () => !!auth.pin;

// Only someone sitting at the computer may set the first PIN: the request must come straight to
// loopback with no proxy headers (Tailscale Serve and other proxies add forwarding headers).
export function isDirectLocal(req) {
  const ip = req.socket.remoteAddress || '';
  const loop = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const proxied = Object.keys(req.headers).some(h => h.startsWith('x-forwarded') || h.startsWith('tailscale-') || h === 'forwarded' || h === 'via');
  return loop && !proxied;
}

export function setPin(pin) {
  if (!/^\d{6,12}$/.test(String(pin))) throw new Error('Use 6 to 12 digits.');
  const salt = crypto.randomBytes(16).toString('hex');
  auth.pin = { salt, hash: hash(pin, salt) };
  auth.sessions = {}; // changing the PIN signs everything out
  persist();
  audit({ event: 'auth.pin_set' });
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

export function login(req, pin) {
  const ip = clientIp(req);
  const a = attempts.get(ip) || { count: 0, until: 0 };
  if (a.until > Date.now()) throw new Error(`Too many tries. Wait ${Math.ceil((a.until - Date.now()) / 60000)} min.`);
  const ok = auth.pin && crypto.timingSafeEqual(Buffer.from(hash(pin, auth.pin.salt), 'hex'), Buffer.from(auth.pin.hash, 'hex'));
  if (!ok) {
    a.count++;
    if (a.count >= 5) { a.until = Date.now() + 15 * 60 * 1000; a.count = 0; }
    attempts.set(ip, a);
    audit({ event: 'auth.login_failed', ip });
    throw new Error('Wrong PIN.');
  }
  attempts.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  auth.sessions[hash(token, 'session')] = { created: Date.now(), ua: String(req.headers['user-agent'] || '').slice(0, 120) };
  persist();
  audit({ event: 'auth.login', ip });
  return token;
}

export function logout(token) {
  if (!token) return;
  delete auth.sessions[hash(token, 'session')];
  persist();
}

export function check(token) {
  if (!token) return false;
  const s = auth.sessions[hash(token, 'session')];
  if (!s) return false;
  if (Date.now() - s.created > SESSION_DAYS * 864e5) { logout(token); return false; }
  return true;
}

export function cookieHeader(token, req, maxAgeDays = SESSION_DAYS) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
  return `relay_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeDays * 86400}${secure}`;
}

export function tokenFrom(req) {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)relay_session=([^;]+)/);
  return m ? m[1] : null;
}
