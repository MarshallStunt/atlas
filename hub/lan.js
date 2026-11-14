// "Other devices" mode: also serve Aura on the local network (plain HTTP) so a phone or tablet on
// the same Wi-Fi can open it. Note: browsers only allow the microphone on HTTPS pages, so on other
// devices you type to Aura (replies are still spoken).
import { execFileSync } from 'node:child_process';
import os from 'node:os';

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
