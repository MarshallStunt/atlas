// Optional: serve Aura over HTTPS on the local network (AURA_LAN=1), so a phone on the same
// Wi-Fi can open it. HTTPS is required for the microphone, so this makes a self-signed certificate
// for this computer's network names and addresses (the phone shows a one-time warning).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA } from './store.js';

export function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
}

function localName() {
  try { return execFileSync('scutil', ['--get', 'LocalHostName']).toString().trim() + '.local'; } catch { return os.hostname().replace(/\.local$/, '') + '.local'; }
}

export function certificate() {
  const dir = path.join(DATA, 'tls');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const names = [localName(), 'localhost'];
  const ips = ['127.0.0.1', ...lanAddresses()];
  const want = JSON.stringify({ names, ips });
  const meta = path.join(dir, 'meta.json'), key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  // Make a new certificate when the network address changes (e.g. a different Wi-Fi).
  if (!fs.existsSync(cert) || !fs.existsSync(meta) || fs.readFileSync(meta, 'utf8') !== want) {
    const san = [...names.map(n => `DNS:${n}`), ...ips.map(i => `IP:${i}`)].join(',');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825', '-subj', '/CN=Aura', '-addext', `subjectAltName=${san}`, '-addext', 'extendedKeyUsage=serverAuth', '-keyout', key, '-out', cert], { stdio: 'ignore' });
    fs.chmodSync(key, 0o600);
    fs.writeFileSync(meta, want, { mode: 0o600 });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert), names, ips };
}
