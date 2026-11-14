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
  browser_tabs: 'browser_read', browser_read: 'browser_read', browser_act: 'browser_act', slack_send: 'browser_act',
};

const run = (cmd, args, { timeout = 6000 } = {}) => new Promise(resolve => {
  execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
    resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), missing: err?.code === 'ENOENT' }));
});
const ps = (script, timeout) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout });
const has = async cmd => (await run(WIN ? 'where' : 'which', [cmd])).ok;

/* ---------------- status ---------------- */
async function battery() {
  if (MAC) {
    const r = await run('pmset', ['-g', 'batt']);
    const m = r.stdout.match(/(\d+)%;\s*([^;]+);/);
    return m ? { percent: Number(m[1]), onAC: /AC Power/.test(r.stdout) } : null;
  }
  if (WIN) {
    const r = await ps('$b=Get-CimInstance Win32_Battery; if($b){"$($b.EstimatedChargeRemaining) $($b.BatteryStatus)"}');
    const m = r.stdout.trim().match(/^(\d+)\s+(\d+)/);
    return m ? { percent: Number(m[1]), onAC: m[2] !== '1' } : null;
  }
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
    const r = await ps('Get-Process | Where-Object {$_.MainWindowTitle} | ForEach-Object {"$($_.ProcessName)`t$($_.MainWindowTitle)"}; "--"; (Get-Process -Name CptHost,aomhost -ErrorAction SilentlyContinue).Count', 10000);
    const [apps, count] = r.stdout.split('--');
    for (const line of apps.split(/\r?\n/)) { const n = line.split('\t')[0].trim(); if (n) names.add(n); }
    if (Number(count) > 0) call = 'Zoom';
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
  if (WIN) {
    const r = await ps(`Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class W{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);}
"@; $s=New-Object Text.StringBuilder 256; [void][W]::GetWindowText([W]::GetForegroundWindow(),$s,256); $s.ToString()`, 8000);
    return r.ok ? r.stdout.trim() || null : null;
  }
  const r = await run('xdotool', ['getactivewindow', 'getwindowname'], { timeout: 3000 });
  return r.ok ? r.stdout.trim() : null;
}

async function idleSeconds() {
  if (MAC) {
    const r = await run('ioreg', ['-c', 'IOHIDSystem', '-d', '4']);
    const m = r.stdout.match(/"HIDIdleTime" = (\d+)/);
    return m ? Math.round(Number(m[1]) / 1e9) : null;
  }
  if (WIN) {
    const r = await ps(`Add-Type @"
using System;using System.Runtime.InteropServices;
public class I{[StructLayout(LayoutKind.Sequential)]public struct L{public uint s;public uint t;}[DllImport("user32.dll")]public static extern bool GetLastInputInfo(ref L l);}
"@; $l=New-Object I+L; $l.s=8; [void][I]::GetLastInputInfo([ref]$l); [int]([Environment]::TickCount - $l.t)/1000`, 8000);
    const n = Number(r.stdout.trim());
    return r.ok && !isNaN(n) ? Math.round(n) : null;
  }
  const r = await run('xprintidle', []);
  return r.ok ? Math.round(Number(r.stdout) / 1000) : null;
}

async function disk() {
  if (WIN) {
    const r = await ps('$d=Get-PSDrive -Name ($env:SystemDrive.TrimEnd(":")); "$($d.Free) $($d.Used)"');
    const [free, used] = r.stdout.trim().split(/\s+/).map(Number);
    return free ? { freeGB: +(free / 1e9).toFixed(1), totalGB: +((free + used) / 1e9).toFixed(1) } : null;
  }
  const r = await run('df', ['-k', os.homedir()]);
  const cols = r.stdout.trim().split('\n').pop()?.split(/\s+/) || [];
  const total = Number(cols[1]) * 1024, free = Number(cols[3]) * 1024;
  return total ? { freeGB: +(free / 1e9).toFixed(1), totalGB: +(total / 1e9).toFixed(1) } : null;
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
  if (MAC) r = await run('osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "Relay"', '-e', 'end run', text]);
  else if (WIN) {
    // The text goes in through an environment variable, never into the script source.
    r = await new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true; $n.ShowBalloonTip(8000,"Relay",$env:RELAY_MSG,"Info"); Start-Sleep 9; $n.Dispose()'],
      { env: { ...process.env, RELAY_MSG: text }, timeout: 15000, windowsHide: true }, err => resolve({ ok: !err, stderr: String(err?.message || '') })));
  } else r = await run('notify-send', ['Relay', text]);
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
  const raw = path.join(os.tmpdir(), `relay-shot-${process.pid}-${Date.now()}.${WIN || LINUX ? 'png' : 'jpg'}`);
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
      const r = await new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b=[System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height
$g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size)
$s=[Math]::Min(1, 1400/[Math]::Max($b.Width,$b.Height)); $w=[int]($b.Width*$s); $h=[int]($b.Height*$s)
$small=New-Object System.Drawing.Bitmap $bmp,$w,$h
$enc=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|?{$_.MimeType -eq 'image/jpeg'}
$p=New-Object System.Drawing.Imaging.EncoderParameters 1; $p.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality),[long]70
$small.Save($env:RELAY_OUT,$enc,$p)`], { env: { ...process.env, RELAY_OUT: out }, timeout: 20000, windowsHide: true }, err => resolve({ ok: !err })));
      if (!r.ok || !fs.existsSync(out)) fail('PowerShell could not capture the screen (it must run in your desktop session, not as a service).');
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
