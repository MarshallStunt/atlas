// What Aura is connected to, and how to fix what isn't. Built from the computer's latest snapshot
// and the hub's own settings, so the phone can show one clear checklist.
import * as devices from './devices.js';
import { getSettings } from './brain.js';
import * as providers from './providers.js';
import { voiceEngine, sttEngine } from './voice.js';
import { SERVER } from './auth.js';

const ago = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const open = (label, url) => ({ type: 'open', label, url });
const goto = (label, section) => ({ type: 'goto', label, section });

// Web apps Aura can read through the browser when they're open in a tab.
const WEB_APPS = [
  ['Outlook', /outlook\.(office|live|office365)\.com/, 'https://outlook.office.com/mail/'],
  ['Microsoft Teams', /teams\.(microsoft|live)\.com/, 'https://teams.microsoft.com/'],
  ['Jira', /atlassian\.net\/(jira|browse|projects)|atlassian\.net\/secure/, null],
  ['Confluence', /atlassian\.net\/wiki/, null],
  ['Google Drive & Docs', /(drive|docs)\.google\.com/, 'https://drive.google.com/'],
  ['GitHub', /github\.com/, 'https://github.com/'],
  ['Notion', /notion\.(so|site)/, null],
  ['Salesforce', /(salesforce|force)\.com/, null],
  ['Zoom', /zoom\.us/, null],
  ['Linear', /linear\.app/, null],
  ['NetSuite', /netsuite\.com/, null],
];

export function connections(net = {}) {
  const s = getSettings();
  const dev = devices.listDevices().find(d => d.selected);
  const snap = dev ? devices.snapshotOf(dev.id) : null;
  const caps = snap?.capabilities || {};
  const inbox = snap?.inbox || {};
  const bridge = snap?.bridge || {};
  const errs = inbox.errors || {};
  const out = [];
  const add = (group, name, status, detail, fix) => out.push({ group, name, status, detail, fix: fix || null });

  // ---- computer ----
  if (!dev) add('Computer', 'Computer agent', 'off', 'No computer is paired yet.', { type: 'text', how: 'On the computer, run the Aura installer and enter its pairing code below.' });
  else if (!dev.online) add('Computer', `${dev.name}`, 'error', `Offline${dev.lastSeen ? ', last seen ' + ago(Date.parse(dev.lastSeen)) : ''}.`, { type: 'text', how: 'Make sure the computer is awake and online. Aura starts at login; to restart it run: launchctl kickstart -k gui/$(id -u)/com.aura.agent' });
  else add('Computer', `${dev.name}`, 'ok', `Online · ${snap?.computer?.platform || dev.platform}`);

  const syncAge = bridge.lastSync ? Date.now() - bridge.lastSync : Infinity;
  const pollAge = bridge.lastPoll ? Date.now() - bridge.lastPoll : Infinity;
  const bridgeOk = dev?.online && syncAge < 3 * 60000;
  const extHow = `In Chrome (or Edge/Brave) on the computer open chrome://extensions, turn on Developer mode, remove any old "Relay Bridge", then Load unpacked → ${bridge.folder || '~/Desktop/aura/bridge'}. It connects by itself within a minute.`;
  if (!dev) {}
  else if (!caps.browser_read) add('Computer', 'Browser extension', 'off', 'Reading web apps is switched off on the computer.', { type: 'text', how: 'Turn on "Read your signed-in web apps" at http://127.0.0.1:8101 on the computer.' });
  else if (bridgeOk) add('Computer', 'Browser extension', 'ok', `Syncing · last update ${ago(bridge.lastSync)}`);
  else if (pollAge < 3 * 60000) add('Computer', 'Browser extension', 'warn', `Connected, last full sync ${bridge.lastSync ? ago(bridge.lastSync) : 'not yet'}.`, { type: 'reconnect', label: 'Resync now' });
  else add('Computer', 'Browser extension', 'error', `${bridge.lastSync ? `Not syncing since ${ago(bridge.lastSync)}.` : 'Never connected.'} Aura restarts the browser by itself if it's closed; if it stays red, the extension needs reloading.`, { type: 'text', how: extHow });

  // ---- core apps ----
  const app = (name, key, data, okText, url) => {
    if (!dev) return;
    if (!caps.browser_read) return add('Apps', name, 'off', 'Off: reading web apps is switched off on the computer.');
    if (errs[key] && /^SIGN_IN:/.test(errs[key])) return add('Apps', name, 'error', errs[key].replace(/^SIGN_IN:\s*/, '') + ' Aura can\'t sign in for you.', open(`Open ${name} to sign in`, url));
    if (errs[key]) return add('Apps', name, 'warn', `${errs[key].replace(/; retrying next minute$/, '')}. Aura retries automatically every minute.`, { type: 'reconnect', label: 'Retry now' });
    if (!data) return add('Apps', name, 'off', 'No data yet.', open(`Open ${name} on computer`, url));
    if (!dev.online) return add('Apps', name, 'warn', 'Showing the last data from before the computer went offline.');
    if (!bridgeOk) return add('Apps', name, 'warn', bridge.lastSync ? `Showing data from ${ago(bridge.lastSync)}: the browser extension isn't syncing.` : 'Showing old data: the browser extension isn\'t syncing.');
    add('Apps', name, 'ok', okText(data));
  };
  app('Gmail', 'gmail', inbox.gmail, d => `${d.unread} unread`, 'https://mail.google.com/');
  app('Google Calendar', 'calendar', inbox.calendar, d => `${(d.events || []).length} upcoming events`, 'https://calendar.google.com/');
  app('Slack', 'slack', inbox.slack, d => `${d.team || 'workspace'} · ${(d.mentions || []).length} recent mentions`, 'https://app.slack.com/client');

  // ---- other web apps, readable on request when open ----
  const tabs = inbox.openTabs || [];
  for (const [name, re, url] of WEB_APPS) {
    const hit = tabs.some(t => re.test(t.url || ''));
    if (hit) add('Web apps', name, caps.browser_read && bridgeOk ? 'ok' : 'warn', caps.browser_read && bridgeOk ? 'Open in the browser: Aura can read it when you ask.' : 'Open, but the extension isn\'t syncing.');
    else if (url) add('Web apps', name, 'idle', 'Not open. Aura can use it once it\'s open in the browser.', open(`Open ${name} on computer`, url));
  }

  // ---- permissions on the computer ----
  if (dev) {
    const perm = (key, name, onText) => add('Permissions', name, caps[key] ? 'ok' : 'off', caps[key] ? onText : 'Switched off on the computer.', caps[key] ? null : { type: 'text', how: `Turn on "${name}" at http://127.0.0.1:8101 on the computer. Only someone at the computer can change this.` });
    perm('screen', 'View the screen', 'On. If screenshots come back blank, give Node Screen Recording permission in System Settings → Privacy & Security.');
    perm('browser_act', 'Act in web apps', 'On. Each action still asks for your approval.');
    perm('shell', 'Run shell commands', 'On. Each command still asks for your approval.');
    perm('notify', 'Notifications and lock screen', 'On.');
  }

  // ---- AI ----
  const p = providers.PROVIDERS[s.provider];
  add('AI', `Assistant · ${p?.label || s.provider}`, providers.isReady(s, s.provider) ? 'ok' : 'error', providers.isReady(s, s.provider) ? s.model : 'No API key saved.', providers.isReady(s, s.provider) ? null : goto('Add key', 'assistant'));
  const ve = voiceEngine(s), se = sttEngine(s);
  add('AI', 'Voice (speaking)', ve === 'browser' ? 'warn' : 'ok', ve === 'elevenlabs' ? 'ElevenLabs' : ve === 'openai' ? 'OpenAI' : 'Using the phone\'s basic voice.', ve === 'browser' ? goto('Add a voice key', 'voice') : null);
  add('AI', 'Voice (listening)', se === 'browser' ? 'warn' : 'ok', se === 'openai' ? 'OpenAI transcription' : 'Browser speech recognition (cuts off easily; doesn\'t work in Brave).', se === 'browser' ? goto('Add an OpenAI key', 'voice') : null);

  // ---- reach ----
  if (SERVER) add('Access', 'Other devices', 'ok', 'Hub is hosted; open it from any signed-in device.');
  else if (net.on) add('Access', 'Other devices', 'ok', `On your Wi-Fi: ${net.secureUrls?.[0] || net.urls?.[0]} (talking works on the https address).`);
  else if (net.error) add('Access', 'Other devices', 'error', net.error, goto('Open settings', 'network'));
  else add('Access', 'Other devices', 'off', 'Only this computer can open Aura.', goto('Turn on', 'network'));

  const counts = out.reduce((c, x) => (c[x.status] = (c[x.status] || 0) + 1, c), {});
  return { items: out, counts, checkedAt: Date.now() };
}
