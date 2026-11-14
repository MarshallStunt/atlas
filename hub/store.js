// Hub storage: small JSON files in ~/.aura-hub (owner-only permissions) and an append-only audit log.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DATA = process.env.AURA_HUB_DATA || path.join(os.homedir(), '.aura-hub');
fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });

const file = name => path.join(DATA, name);

export function load(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); }
  catch { return structuredClone(fallback); }
}

export function save(name, value) {
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file(name));
}

// Every action that touches a device or the account is recorded here.
export function audit(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(file('audit.jsonl'), line, { mode: 0o600 });
}

export function recentAudit(n = 50) {
  try {
    const lines = fs.readFileSync(file('audit.jsonl'), 'utf8').trim().split('\n');
    return lines.slice(-n).reverse().map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
