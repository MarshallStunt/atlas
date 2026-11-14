// Runs the hub and this computer's agent together (the single-user setup on one machine).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const run = (name, file) => {
  const child = spawn(process.execPath, [file, ...process.argv.slice(2)], { stdio: ['inherit', 'pipe', 'pipe'] });
  const tag = line => line && console.log(`[${name}] ${line}`);
  child.stdout.on('data', d => String(d).split('\n').forEach(tag));
  child.stderr.on('data', d => String(d).split('\n').forEach(tag));
  child.on('exit', code => { console.log(`[${name}] exited (${code})`); process.exit(code ?? 1); });
  return child;
};
run('hub', fileURLToPath(new URL('./hub/server.js', import.meta.url)));
setTimeout(() => run('agent', fileURLToPath(new URL('./agent/agent.js', import.meta.url))), 800);
