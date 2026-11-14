// What the agent can do on this computer (Windows, macOS, Linux). Each capability belongs to a
// policy switch that only the person at this computer can change (http://127.0.0.1:8101).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OS = process.platform; // 'darwin' | 'win32' | 'linux'
const MAC = OS === 'darwin', WIN = OS === 'win32', LINUX = OS === 'linux';

export const POLICY_DEFAULTS = {
  status: { on: true, label: 'See computer status', detail: 'Battery, running apps, front window, idle time, Zoom/Teams call, disk and memory.' },
  browser_read: { on: true, label: 'Read your signed-in web apps', detail: 'Through the browser extension: calendar, mail, chat and any site open or signed in in your browser.' },
  open: { on: true, label: 'Open links and drafts', detail: 'Open a link, or an email draft you still send yourself.' },
  notify: { on: true, label: 'Notifications and lock screen', detail: 'Show a notification here or lock the screen.' },
  screen: { on: false, label: 'View the screen', detail: 'Screenshots when asked, so desktop apps (Outlook, Teams, anything) can be read too. macOS also asks for Screen Recording permission.' },
  browser_act: { on: false, label: 'Act in web apps', detail: 'Click and type in your browser tabs, e.g. send a Slack or Teams message. Each action still needs your Approve tap.' },
  shell: { on: false, label: 'Run shell commands', detail: 'As you, 60 s limit. Each command still needs your Approve tap.' },
};

export const TOOL_POLICY = {
  get_overview: 'status', view_screen: 'screen', open_on_computer: 'open', draft_email: 'open',
  notify_computer: 'notify', lock_computer: 'notify', run_command: 'shell',
  browser_tabs: 'browser_read', browser_read: 'browser_read', reconnect: 'browser_read', set_apps: 'status', set_space: 'status', get_config: 'status', apply_config: 'status', browser_act: 'browser_act', slack_send: 'browser_act',
};

const run = (cmd, args, { timeout = 6000 } = {}) => new Promise(resolve => {
  execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
    resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), missing: err?.code === 'ENOENT' }));
});
const has = async cmd => (await run(WIN ? 'where' : 'which', [cmd])).ok;

/* ---------------- status ---------------- */
async function battery() {
  if (MAC) {
    const r = await run('pmset', ['-g', 'batt']);
    const m = r.stdout.match(/(\d+)%;\s*([^;]+);/);
    return m ? { percent: Number(m[1]), onAC: /AC Power/.test(r.stdout) } : null;
  }
  if (WIN) return null; // no background PowerShell on Windows (security tools flag it), so no battery there
  try {
    const dir = '/sys/class/power_supply';
    const bat = fs.readdirSync(dir).find(d => d.startsWith('BAT'));
    if (!bat) return null;
    const percent = Number(fs.readFileSync(path.join(dir, bat, 'capacity'), 'utf8'));
    const st = fs.readFileSync(path.join(dir, bat, 'status'), 'utf8').trim();
    return { percent, onAC: st !== 'Discharging' };
  } catch { return null; }
}

// Apps with a window the user would recognise, plus whether a Zoom or Teams call is running.
async function runningApps() {
  const names = new Set();
  let call = null;
  if (WIN) {
    // tasklist is a plain built-in Windows tool; apps with a window title are the ones the user sees.
    const r = await run('tasklist', ['/fo', 'csv', '/nh', '/v'], { timeout: 15000 });
    for (const line of r.stdout.split(/\r?\n/)) {
      const cols = line.match(/"([^"]*)"/g)?.map(c => c.slice(1, -1));
      if (!cols || cols.length < 9) continue;
      const image = cols[0].replace(/\.exe$/i, ''), title = cols[8];
      if (/^(CptHost|aomhost)$/i.test(image)) call = 'Zoom';
      if (title && title !== 'N/A' && !/^(explorer|SearchHost|TextInputHost|ShellExperienceHost|ApplicationFrameHost)$/i.test(image)) names.add(image);
    }
  } else {
    const r = await run('ps', ['-axo', 'comm=']);
    for (const line of r.stdout.split('\n')) {
      const m = MAC ? line.match(/\/([^/]+)\.app\/Contents\/MacOS\//) : null;
      if (m && !line.includes('/System/') && !/Helper|Agent|Updater|crashpad/i.test(line)) names.add(m[1]);
      if (LINUX) { const n = path.basename(line.trim()); if (/^(chrome|chromium|firefox|code|slack|zoom|teams|thunderbird|evolution|libreoffice|brave|msedge|obsidian|spotify)/i.test(n)) names.add(n); }
      if (/CptHost|aomhost/.test(line)) call = 'Zoom';
    }
  }
  return { apps: [...names].sort().slice(0, 40), call };
}

async function frontWindow() {
  if (MAC) {
    const r = await run('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'], { timeout: 3000 });
    return r.ok ? r.stdout.trim() : null;
  }
  if (WIN) return null; // would need PowerShell + Win32 calls, which security tools flag
  const r = await run('xdotool', ['getactivewindow', 'getwindowname'], { timeout: 3000 });
  return r.ok ? r.stdout.trim() : null;
}

async function idleSeconds() {
  if (MAC) {
    const r = await run('ioreg', ['-c', 'IOHIDSystem', '-d', '4']);
    const m = r.stdout.match(/"HIDIdleTime" = (\d+)/);
    return m ? Math.round(Number(m[1]) / 1e9) : null;
  }
  if (WIN) return null; // same reason as above
  const r = await run('xprintidle', []);
  return r.ok ? Math.round(Number(r.stdout) / 1000) : null;
}

// Node's own disk check: no external program on any OS.
async function disk() {
  try {
    const st = await fs.promises.statfs(WIN ? (process.env.SystemDrive || 'C:') + '\\' : os.homedir());
    const total = st.blocks * st.bsize, free = st.bavail * st.bsize;
    return total ? { freeGB: +(free / 1e9).toFixed(1), totalGB: +(total / 1e9).toFixed(1) } : null;
  } catch { return null; }
}

export async function status() {
  const [batt, apps, front, dsk, idle] = await Promise.all([battery(), runningApps(), frontWindow(), disk(), idleSeconds()]);
  return {
    host: os.hostname(), platform: { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[OS] || OS, user: os.userInfo().username,
    uptimeHours: +(os.uptime() / 3600).toFixed(1), memoryUsedPct: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    battery: batt, frontWindow: front, idleSeconds: idle, inCall: apps.call, apps: apps.apps, disk: dsk,
  };
}

/* ---------------- actions ---------------- */
function safeUrl(u) {
  let url; try { url = new URL(String(u)); } catch { throw new Error('That is not a valid link.'); }
  if (!['https:', 'http:', 'zoommtg:', 'msteams:', 'slack:'].includes(url.protocol)) throw new Error('Only web, Zoom, Teams and Slack links can be opened.');
  return url.toString();
}

async function openUrl(u) {
  const url = safeUrl(u);
  // Windows: "start" via cmd would parse & and ^ in the URL; rundll32 hands it straight to the default handler.
  const r = MAC ? await run('open', [url]) : WIN ? await run('rundll32', ['url.dll,FileProtocolHandler', url]) : await run('xdg-open', [url]);
  if (!r.ok) throw new Error('Could not open the link. ' + r.stderr.slice(0, 200));
  return { ok: true, opened: url };
}

async function notify(message) {
  const text = String(message).replace(/[\r\n]+/g, ' ').slice(0, 240);
  let r;
  if (MAC) r = await run('osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "Aura"', '-e', 'end run', text]);
  else if (WIN) {
    // The text goes in through an environment variable, never into the script source.
    r = await new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true; $n.ShowBalloonTip(8000,"Aura",$env:AURA_MSG,"Info"); Start-Sleep 9; $n.Dispose()'],
      { env: { ...process.env, AURA_MSG: text }, timeout: 15000, windowsHide: true }, err => resolve({ ok: !err, stderr: String(err?.message || '') })));
  } else r = await run('notify-send', ['Aura', text]);
  if (!r.ok) throw new Error('Notification failed. ' + (r.missing ? 'Install notify-send.' : r.stderr.slice(0, 200)));
  return { ok: true };
}

async function lock() {
  let r;
  if (MAC) r = await run('pmset', ['displaysleepnow']);
  else if (WIN) r = await run('rundll32.exe', ['user32.dll,LockWorkStation']);
  else { r = await run('loginctl', ['lock-session']); if (!r.ok) r = await run('xdg-screensaver', ['lock']); }
  if (!r.ok) throw new Error('Could not lock the screen.');
  return { ok: true, note: MAC ? 'Display is asleep; it locks if a password is required after sleep.' : 'Screen locked.' };
}

async function screenshot() {
  const raw = path.join(os.tmpdir(), `aura-shot-${process.pid}-${Date.now()}.${WIN || LINUX ? 'png' : 'jpg'}`);
  const out = raw.replace(/\.png$/, '.jpg');
  const fail = hint => { throw new Error('Screenshot failed. ' + hint); };
  try {
    if (MAC) {
      const r = await run('screencapture', ['-x', '-t', 'jpg', raw], { timeout: 10000 });
      if (!r.ok || !fs.existsSync(raw)) fail('Give your terminal (or Node) Screen Recording permission in System Settings → Privacy & Security.');
      await run('sips', ['-Z', '1400', '-s', 'formatOptions', '70', raw, '--out', raw], { timeout: 10000 });
      return shotResult(raw);
    }
    if (WIN) {
      // Only runs when you ask for a screenshot. Plain .NET drawing calls; any failure comes back word for word.
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
        '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
        '$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)',
        '$g = [System.Drawing.Graphics]::FromImage($bmp)',
        '$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)',
        '$s = [Math]::Min(1.0, 1400.0 / [Math]::Max($b.Width, $b.Height))',
        '$small = New-Object System.Drawing.Bitmap($bmp, [int]($b.Width * $s), [int]($b.Height * $s))',
        '$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }',
        '$p = New-Object System.Drawing.Imaging.EncoderParameters(1)',
        '$p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]70)',
        '$small.Save($env:AURA_OUT, $enc, $p)',
        '$g.Dispose(); $bmp.Dispose(); $small.Dispose()',
      ].join('; ');
      const r = await new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { env: { ...process.env, AURA_OUT: out }, timeout: 25000, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, err: String(stderr || err?.message || '').trim() })));
      if (!r.ok || !fs.existsSync(out)) {
        const why = /CopyFromScreen|handle is invalid|desktop/i.test(r.err) ? 'Windows has no screen to capture right now (locked, asleep, or Aura is running outside your desktop session).' : r.err.split('\n').slice(0, 3).join(' ').slice(0, 300);
        fail(why || 'PowerShell could not capture the screen.');
      }
      return shotResult(out);
    }
    // Linux: whichever screenshot tool is installed (Wayland: grim; X11: scrot / ImageMagick import / gnome-screenshot).
    for (const [cmd, args] of [['grim', [raw]], ['gnome-screenshot', ['-f', raw]], ['scrot', ['-o', raw]], ['import', ['-window', 'root', raw]], ['spectacle', ['-b', '-n', '-o', raw]]]) {
      const r = await run(cmd, args, { timeout: 10000 });
      if (r.ok && fs.existsSync(raw)) {
        if (await has('convert')) { await run('convert', [raw, '-resize', '1400x1400>', '-quality', '70', out]); if (fs.existsSync(out)) return shotResult(out); }
        return shotResult(raw, 'image/png');
      }
    }
    fail('Install grim (Wayland) or scrot (X11).');
  } finally { for (const p of [raw, out]) fs.rm(p, { force: true }, () => {}); }
}
function shotResult(file, mediaType = 'image/jpeg') {
  return { image: fs.readFileSync(file).toString('base64'), mediaType, note: `Screenshot of ${os.hostname()} at ${new Date().toLocaleTimeString()}.` };
}

async function shell(command) {
  const [cmd, args] = WIN ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]] : [process.env.SHELL || '/bin/sh', ['-lc', command]];
  const r = await new Promise(resolve => execFile(cmd, args, { cwd: os.homedir(), timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, timedOut: !!err?.killed, stdout: String(stdout), stderr: String(stderr) })));
  const cut = s => s.length > 8000 ? s.slice(0, 4000) + '\n…\n' + s.slice(-4000) : s;
  return { exitCode: r.code, timedOut: r.timedOut, stdout: cut(r.stdout), stderr: cut(r.stderr) };
}

export function makeTools({ overview, browser }) {
  return {
    get_overview: () => overview(),
    view_screen: () => screenshot(),
    open_on_computer: ({ url }) => openUrl(url),
    draft_email: ({ to, subject, body, service }) => openUrl(service === 'outlook'
      ? 'https://outlook.office.com/mail/deeplink/compose?' + new URLSearchParams({ to, subject, body })
      : 'https://mail.google.com/mail/?view=cm&fs=1&' + new URLSearchParams({ to, su: subject, body })),
    notify_computer: ({ message }) => notify(message),
    lock_computer: () => lock(),
    run_command: ({ command }) => shell(command),
    browser_tabs: () => browser('tabs', {}),
    browser_read: input => browser('read', input),
    browser_act: input => browser('act', input),
    slack_send: input => browser('slack_send', input),
  };
}

/* ---------------- which apps Aura uses on this computer ----------------
   Computers differ (Gmail here, Outlook there). "synced" apps feed the dashboard; the rest are read
   only when you ask. Turned-off apps are not synced, not opened, not read and not acted in. */
export const APPS = [
  { id: 'gmail', name: 'Gmail', kind: 'mail', synced: true, match: 'mail\\.google\\.com' },
  { id: 'gcal', name: 'Google Calendar', kind: 'calendar', synced: true, match: 'calendar\\.google\\.com' },
  { id: 'slack', name: 'Slack', kind: 'chat', synced: true, match: '(^|\\.)slack\\.com' },
  { id: 'outlook', name: 'Outlook (mail & calendar)', kind: 'mail', synced: true, def: false, match: 'outlook\\.(office|office365|live)\\.com|outlook\\.cloud\\.microsoft' },
  { id: 'teams', name: 'Microsoft Teams', kind: 'chat', match: 'teams\\.(microsoft|live|cloud\\.microsoft)\\.com|teams\\.cloud\\.microsoft' },
  { id: 'gdrive', name: 'Google Drive & Docs', kind: 'docs', match: '(drive|docs|sheets|slides)\\.google\\.com' },
  { id: 'jira', name: 'Jira', kind: 'work', match: 'atlassian\\.net/(jira|browse|projects|secure)' },
  { id: 'confluence', name: 'Confluence', kind: 'docs', match: 'atlassian\\.net/wiki' },
  { id: 'github', name: 'GitHub', kind: 'work', match: '(^|\\.)github\\.com' },
  { id: 'notion', name: 'Notion', kind: 'docs', match: 'notion\\.(so|site)' },
  { id: 'salesforce', name: 'Salesforce', kind: 'work', match: '(salesforce|force|lightning\\.force)\\.com' },
  { id: 'zoom', name: 'Zoom (web)', kind: 'meeting', match: '(^|\\.)zoom\\.us' },
  { id: 'linear', name: 'Linear', kind: 'work', match: 'linear\\.app' },
];
const appRe = Object.fromEntries(APPS.map(a => [a.id, new RegExp(a.match, 'i')]));
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// An organization's own Outlook server (e.g. owa.school.edu) counts as Outlook too.
export const outlookHosts = choices => [choices.outlookMailUrl, choices.outlookCalUrl].filter(Boolean).map(u => { try { return new URL(u).host; } catch { return null; } }).filter(Boolean);
export const matcherFor = (app, choices) => app.id === 'outlook' && outlookHosts(choices || {}).length ? `${app.match}|${outlookHosts(choices).map(escRe).join('|')}` : app.match;
export const appOf = (url, choices) => { const u = String(url || '').replace(/^https?:\/\//, ''); return APPS.find(a => (choices ? new RegExp(matcherFor(a, choices), 'i') : appRe[a.id]).test(u)) || null; };
// "owa.school.edu/#path=/mail" -> "https://owa.school.edu/#path=/mail"; empty stays empty.
export function cleanLink(v) {
  v = String(v || '').trim(); if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  const u = new URL(v); if (u.protocol !== 'https:') throw new Error('Use an https link.');
  return u.toString();
}
// Is reading/acting on this page allowed by the app choices? { ok, app, reason }
export function urlAllowed(url, choices) {
  if (!/^https?:\/\//i.test(String(url || ''))) return { ok: true };
  const app = appOf(url, choices);
  if (app) return choices.apps[app.id] === false ? { ok: false, app, reason: `${app.name} is turned off for this computer in Aura (System → Apps).` } : { ok: true, app };
  return choices.otherSites === false ? { ok: false, reason: 'Only the apps chosen for this computer can be read (System → Apps → Other websites is off).' } : { ok: true };
}
