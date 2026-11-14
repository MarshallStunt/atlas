// "Other devices" mode: also serve Aura on the local network so a phone or tablet on the same Wi-Fi
// can open it: plain HTTP on 8080, and HTTPS on 8443 for talking (browsers only allow the mic on HTTPS).
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import selfsigned from 'selfsigned';
import { DATA } from './store.js';

export function lanAddresses() {
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => !/^(utun|tun|tap|docker|veth|br-|vmnet|vEthernet|Tailscale|ZeroTier)/i.test(name))
    .flatMap(([, list]) => list || [])
    .filter(a => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.') && !a.address.startsWith('100.'))
    .map(a => a.address);
}

export function localName() {
  if (process.platform === 'darwin') { try { return execFileSync('scutil', ['--get', 'LocalHostName']).toString().trim() + '.local'; } catch {} }
  return os.hostname().replace(/\.local$/i, '') + '.local';
}

// HTTPS for other devices, so the microphone works there too. The certificate is made here in pure
// JavaScript (any OS) for this computer's names and addresses; phones show a one-time warning
// because it isn't from a public authority.

export async function certificate() {
  const dir = path.join(DATA, 'tls');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const names = [localName(), 'localhost'];
  const ips = ['127.0.0.1', ...lanAddresses()];
  const want = JSON.stringify({ names, ips });
  const meta = path.join(dir, 'meta.json'), keyFile = path.join(dir, 'key.pem'), certFile = path.join(dir, 'cert.pem');
  // New certificate when the network address changes (e.g. a different Wi-Fi).
  if (!fs.existsSync(certFile) || !fs.existsSync(meta) || fs.readFileSync(meta, 'utf8') !== want) {
    const notAfter = new Date(); notAfter.setDate(notAfter.getDate() + 825);
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'Aura' }], {
      keySize: 2048, notAfterDate: notAfter,
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [...names.map(value => ({ type: 2, value })), ...ips.map(ip => ({ type: 7, ip }))] },
      ],
    });
    fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
    fs.writeFileSync(certFile, pems.cert, { mode: 0o600 });
    fs.writeFileSync(meta, want, { mode: 0o600 });
  }
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}
