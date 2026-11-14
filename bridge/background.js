// Aura Bridge: every minute, read Gmail (unread), Google Calendar (agenda) and Slack (mentions)
// using this Chrome's own sign-in, and hand the result to the Aura agent on this computer.
// It also waits for jobs from the agent (sending a Slack message the user approved on their phone).
// No passwords or Slack tokens are stored: Slack calls run inside the open Slack tab.

const decode = s => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const settings = () => chrome.storage.local.get(['agent', 'token', 'email']).then(s => ({ agent: s.agent || 'http://127.0.0.1:8101', token: s.token || '', email: s.email || '' }));

// Connect to the agent on this computer without any copy-pasting: the agent hands its token only
// to a request whose Origin is a browser extension, which web pages can't fake.
// Which browser this is, so the agent can relaunch the right one if it's closed.
function browserName() {
  if (navigator.brave) return 'Brave Browser';
  const brands = (navigator.userAgentData?.brands || []).map(b => b.brand).join(' ');
  return /Edge/.test(brands) ? 'Microsoft Edge' : /Opera/.test(brands) ? 'Opera' : 'Google Chrome';
}
// Every browser that loads this extension from the same folder gets the same extension ID, so each
// install makes its own random ID; that's how Aura tells Chrome, Brave, Edge and profiles apart.
async function installId() {
  let { installId: id } = await chrome.storage.local.get('installId');
  if (!id) { id = crypto.randomUUID(); await chrome.storage.local.set({ installId: id }); }
  return id;
}
async function ensureToken() {
  const s = await settings();
  if (s.token) return s;
  const r = await fetch(s.agent + '/bridge/hello', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ browser: browserName(), installId: await installId() }) });
  if (!r.ok) throw new Error(r.status === 403 ? 'browser access is switched off in the agent' : 'agent said ' + r.status);
  const { token, space } = await r.json();
  await chrome.storage.local.set({ token, space: space || '' });
  return { ...s, token };
}
async function toAgent(path, opts = {}) {
  let s = await ensureToken();
  const go = () => fetch(s.agent + path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Aura-Bridge': s.token, ...(opts.headers || {}) } });
  let r = await go();
  if (r.status === 401) { await chrome.storage.local.remove('token'); s = await ensureToken(); r = await go(); } // agent was reinstalled
  return r;
}

/* ---------- fetch with the user's sign-in (directly, or inside an open tab of that site) ---------- */
async function fetchInPage(u) {
  try {
    const r = await fetch(u, { credentials: 'include' });
    return { ok: r.ok, status: r.status, url: r.url, text: await r.text() };
  } catch (e) { return { error: String(e.message || e) }; }
}
/* ---------- self-healing app tabs ----------
   Each app Aura reads (Gmail, Calendar, Slack) needs a signed-in tab. If the user's own tab is gone,
   Aura keeps its own pinned background tab; if Chrome put the tab to sleep or it crashed, Aura
   reloads it. Only a real sign-out needs the user, and that is reported as SIGN_IN. */
const SIGN_IN_PAGE = /accounts\.google\.com|ServiceLogin|\/signin|slack\.com\/(signin|workspace-signin|checkcookie)/i;
async function appTab(key, pattern, openUrl) {
  const tabs = await chrome.tabs.query({ url: pattern });
  let tab = tabs.find(t => t.status === 'complete' && !t.discarded) || tabs[0];
  let fresh = false;
  if (!tab) {
    const stored = (await chrome.storage.local.get('tabs')).tabs || {};
    tab = stored[key] && await chrome.tabs.get(stored[key]).catch(() => null);
    if (!tab) {
      tab = await chrome.tabs.create({ url: openUrl, active: false, pinned: true });
      await chrome.storage.local.set({ tabs: { ...stored, [key]: tab.id } });
      fresh = true;
    }
  }
  if (tab.discarded || tab.status === 'unloaded' || tab.frozen) { await chrome.tabs.reload(tab.id); fresh = true; }
  if (fresh) await waitLoaded(tab.id, 30000);
  tab = await chrome.tabs.get(tab.id);
  if (SIGN_IN_PAGE.test(tab.url || '')) throw new Error(`SIGN_IN: you're signed out of ${key}. Sign in once in the pinned ${key} tab.`);
  return { tab, fresh };
}
// Run a function inside the app's tab; if the tab is broken, reload it once and try again.
async function inAppTab(key, pattern, openUrl, func, args) {
  let { tab, fresh } = await appTab(key, pattern, openUrl);
  const run = async () => (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args }))[0]?.result;
  try { return { result: await run(), tab, fresh }; }
  catch {
    await chrome.tabs.reload(tab.id); await waitLoaded(tab.id, 30000);
    tab = await chrome.tabs.get(tab.id);
    if (SIGN_IN_PAGE.test(tab.url || '')) throw new Error(`SIGN_IN: you're signed out of ${key}. Sign in once in the pinned ${key} tab.`);
    return { result: await run(), tab, fresh: true };
  }
}
async function fetchSignedIn(url, { name, tabPattern, openUrl, good }) {
  try {
    const r = await fetch(url, { credentials: 'include' });
    const res = { ok: r.ok, status: r.status, url: r.url, text: await r.text() };
    if (good(res)) return res;
  } catch {}
  const { result } = await inAppTab(name, tabPattern, openUrl, fetchInPage, [url]);
  if (result && !result.error && good(result)) return result;
  if (result && SIGN_IN_PAGE.test(result.url || '')) throw new Error(`SIGN_IN: you're signed out of ${name}. Sign in once in the pinned ${name} tab.`);
  throw new Error(`couldn't read ${name} (${result?.error || 'HTTP ' + result?.status}); retrying next minute`);
}

/* ---------- Gmail: unread inbox from the Atom feed ---------- */
const tag = (x, t) => decode((x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '');
async function gmail() {
  const x = (await fetchSignedIn('https://mail.google.com/mail/u/0/feed/atom', { name: 'Gmail', tabPattern: 'https://mail.google.com/*', openUrl: 'https://mail.google.com/mail/u/0/', good: r => r.ok && /<feed/.test(r.text) })).text;
  return {
    email: (tag(x, 'title').match(/[\w.+-]+@[\w.-]+/) || [])[0] || '',
    unread: Number((x.match(/<fullcount>(\d+)/) || [])[1]) || 0,
    entries: x.split('<entry>').slice(1, 26).map(e => ({
      subject: tag(e, 'title') || '(no subject)', snippet: tag(e, 'summary').slice(0, 240), from: tag(e, 'name'), fromEmail: tag(e, 'email'),
      at: Date.parse(tag(e, 'issued') || tag(e, 'modified')) || Date.now(),
      link: decode((e.match(/<link[^>]*href="([^"]+)"/) || [])[1] || 'https://mail.google.com/'),
    })),
  };
}

/* ---------- Google Calendar: agenda view of the user's own calendar ---------- */
function parseWhen(dateText, timeText) {
  const day = new Date(dateText.replace(/^\w+\s+/, ''));
  if (isNaN(day)) return { at: null, allDay: true };
  const m = String(timeText || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return { at: day.getTime(), allDay: true };
  let h = Number(m[1]) % 12; if (/pm/i.test(m[3])) h += 12;
  day.setHours(h, Number(m[2] || 0), 0, 0);
  return { at: day.getTime(), allDay: false };
}
async function calendar(email) {
  if (!email) throw new Error('needs your email (set it in the bridge options, or let Gmail sync first)');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const r = await fetchSignedIn(`https://calendar.google.com/calendar/htmlembed?src=${encodeURIComponent(email)}&mode=AGENDA&ctz=${encodeURIComponent(tz)}`, {
    name: 'Google Calendar', tabPattern: 'https://calendar.google.com/*', openUrl: 'https://calendar.google.com/calendar/u/0/r',
    good: r => r.ok && !/ServiceLogin|accounts\.google\.com/.test(r.url) && /<body/.test(r.text) });
  const events = [];
  for (const sec of r.text.split('class="date-section').slice(1)) {
    const date = decode((sec.match(/<div class="date">([^<]+)</) || [])[1] || '');
    for (const row of sec.match(/<tr class="event">[\s\S]*?<\/tr>/g) || []) {
      const time = decode((row.match(/class="event-time">([^<]*)</) || [])[1] || '');
      const title = decode(((row.match(/<span class="event-summary">([\s\S]*?)<\/span>/) || [])[1] || '').replace(/<[^>]+>/g, '')).trim();
      let link = decode((row.match(/<a[^>]*href="([^"]+)"/) || [])[1] || '');
      if (link && !/^https?:/.test(link)) link = 'https://calendar.google.com' + (link.startsWith('/') ? '' : '/calendar/') + link;
      events.push({ date, time, title, link: link || 'https://calendar.google.com/', ...parseWhen(date, time) });
    }
  }
  return { email, timeZone: tz, events: events.slice(0, 60) };
}

/* ---------- Slack: runs inside the open Slack tab with that tab's own session ---------- */
async function slackInPage(job) {
  try {
    const cfg = JSON.parse(localStorage.getItem('localConfig_v2') || 'null');
    const team = cfg && Object.values(cfg.teams || {})[0];
    if (!team?.token) return { ok: false, error: 'Not signed in to Slack in that tab.' };
    const call = async (m, p = {}) => {
      const fd = new FormData(); fd.append('token', team.token);
      for (const [k, v] of Object.entries(p)) fd.append(k, v);
      const r = await (await fetch('/api/' + m, { method: 'POST', body: fd, credentials: 'include' })).json();
      if (!r.ok) throw new Error(`${m}: ${r.error}`);
      return r;
    };
    const clean = t => String(t || '').replace(/<@[A-Z0-9]+\|([^>]+)>/g, '@$1').replace(/<@[A-Z0-9]+>/g, '@someone')
      .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1').replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2').replace(/<(https?:[^>]+)>/g, '$1')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

    if (!job) {
      const me = await call('auth.test');
      const found = await call('search.messages', { query: `<@${me.user_id}>`, count: 30, sort: 'timestamp' });
      const dms = await call('search.messages', { query: 'is:dm', count: 20, sort: 'timestamp' }).catch(() => null);
      const map = m => ({ at: Math.round(parseFloat(m.ts) * 1000), channel: m.channel?.name || '', isDm: !!(m.channel?.is_im || m.channel?.is_mpim), user: m.username || '', text: clean(m.text).slice(0, 280), link: m.permalink || '' });
      const mentions = [...(found.messages?.matches || []), ...((dms?.messages?.matches) || []).filter(m => m.user !== me.user_id)]
        .map(map).sort((a, b) => b.at - a.at);
      return { ok: true, team: team.name, me: me.user, mentions: mentions.filter((m, i, a) => a.findIndex(x => x.link === m.link) === i).slice(0, 40) };
    }

    // Sending a message the user approved on their phone.
    let channel = '';
    const to = String(job.to || '').trim();
    if (to.startsWith('#')) {
      let cursor = '';
      do {
        const r = await call('users.conversations', { types: 'public_channel,private_channel', limit: 1000, exclude_archived: true, cursor });
        const hit = (r.channels || []).find(c => c.name === to.slice(1).toLowerCase());
        if (hit) { channel = hit.id; break; }
        cursor = r.response_metadata?.next_cursor || '';
      } while (cursor);
      if (!channel) return { ok: false, error: `You aren't in a channel called ${to}.` };
    } else {
      let user;
      if (to.includes('@') && !to.startsWith('@')) user = (await call('users.lookupByEmail', { email: to })).user;
      else {
        const want = to.replace(/^@/, '').toLowerCase();
        const names = u => [u.name, u.real_name, u.profile?.display_name, u.profile?.real_name].map(n => String(n || '').toLowerCase());
        const close = [];
        let cursor = '', pages = 0;
        do {
          const r = await call('users.list', { limit: 1000, cursor });
          for (const u of r.members || []) {
            if (u.deleted || u.is_bot) continue;
            if (names(u).includes(want)) { user = u; break; }
            if (names(u).some(n => n.startsWith(want))) close.push(u);
          }
          cursor = r.response_metadata?.next_cursor || '';
        } while (!user && cursor && ++pages < 20);
        if (!user && close.length === 1) user = close[0];
        if (!user && close.length > 1) return { ok: false, error: `"${to}" matches several people (${close.slice(0, 4).map(u => u.real_name || u.name).join(', ')}). Say the full name or email.` };
      }
      if (!user?.id) return { ok: false, error: `Couldn't find a Slack user "${to}". Try their email address.` };
      channel = (await call('conversations.open', { users: user.id })).channel.id;
    }
    const sent = await call('chat.postMessage', { channel, text: job.text });
    return { ok: true, result: { sent: true, channel: to, ts: sent.ts } };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
// People often use the Slack desktop app, so there may be no Slack tab: Aura keeps its own pinned one.
async function slackTabRun(job) {
  let { result, fresh } = await inAppTab('Slack', 'https://app.slack.com/*', 'https://app.slack.com/client', slackInPage, [job || null]);
  // A freshly (re)loaded Slack client needs a few seconds before it has signed in.
  for (let i = 0; fresh && !result?.ok && /Not signed in/.test(result?.error || '') && i < 6; i++) {
    await new Promise(r => setTimeout(r, 3000));
    ({ result } = await inAppTab('Slack', 'https://app.slack.com/*', 'https://app.slack.com/client', slackInPage, [job || null]));
  }
  if (!result?.ok) throw new Error(/Not signed in/.test(result?.error || '') ? "SIGN_IN: you're signed out of Slack. Sign in once in the pinned Slack tab." : result?.error || 'the Slack tab did not answer; retrying next minute');
  return result;
}

/* ---------- Outlook (Microsoft 365): read from Aura's own pinned Outlook tabs ----------
   Outlook has no simple feed, so Aura keeps two pinned tabs (inbox and work-week calendar) and reads
   what Outlook shows, using its accessibility labels. Nothing is stored except what's sent to the agent. */
const MS_SIGN_IN = /login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com|\/owa\/auth\/logon|\/auth\/logon\.aspx|\/adfs\/ls/i;
// Is the tab still on the page we opened (mail vs calendar), including OWA's "#path=/mail" style links?
function onPage(current, wanted) {
  try {
    const w = new URL(wanted), c = new URL(current || '');
    if (c.host !== w.host && !MS_SIGN_IN.test(c.href)) return false;
    const want = /calendar/i.test(w.pathname + w.hash) ? 'calendar' : 'mail';
    return new RegExp(want, 'i').test(c.pathname + c.hash) || (want === 'mail' && !/calendar/i.test(c.pathname + c.hash));
  } catch { return false; }
}
async function ownTab(key, url) {
  const stored = (await chrome.storage.local.get('ownTabs')).ownTabs || {};
  let tab = stored[key] && await chrome.tabs.get(stored[key]).catch(() => null);
  let fresh = false;
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: false, pinned: true });
    await chrome.storage.local.set({ ownTabs: { ...stored, [key]: tab.id } });
    fresh = true;
  } else if (tab.discarded || !onPage(tab.url, url) || Date.now() - (stored[key + ':loaded'] || 0) > 30 * 60 * 1000) {
    await chrome.tabs.update(tab.id, { url }); fresh = true; // asleep, wandered off, or 30 min old: reload
  }
  if (fresh) { await waitLoaded(tab.id, 40000); await chrome.storage.local.set({ ownTabs: { ...((await chrome.storage.local.get('ownTabs')).ownTabs || {}), [key]: tab.id, [key + ':loaded']: Date.now() } }); }
  tab = await chrome.tabs.get(tab.id);
  if (MS_SIGN_IN.test(tab.url || '')) throw new Error("SIGN_IN: you're signed out of Outlook. Sign in once in the pinned Outlook tab.");
  return tab;
}
// Runs inside the Outlook inbox tab.
async function readOutlookMail() {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let rows = [];
  for (let i = 0; i < 30; i++) {
    rows = [...document.querySelectorAll('[role="listbox"] [role="option"], div[data-convid]')];
    if (rows.length) break;
    if (document.querySelector('[role="listbox"]') && /no items|nothing in folder|all done/i.test(document.body.innerText)) break;
    await wait(500);
  }
  const TIME = /^(\d{1,2}:\d{2}(\s?[AP]M)?|yesterday|(mon|tue|wed|thu|fri|sat|sun)\w*( \d{1,2}[\/.]\d{1,2}(?:[\/.]\d{2,4})?| \d{1,2}:\d{2}(\s?[AP]M)?)?|\d{1,2}[\/.]\d{1,2}([\/.]\d{2,4})?|\w{3,9} \d{1,2}(, \d{4})?)$/i;
  const entries = [], seen = new Set();
  for (const el of rows.slice(0, 40)) {
    const label = el.getAttribute('aria-label') || '';
    const lines = el.innerText.split('\n').map(x => x.trim()).filter(x => x && x.length > 1);
    if (!lines.length) continue;
    const ti = lines.findIndex((l, i) => i > 0 && TIME.test(l));
    const from = lines[0], subject = (ti === 1 ? lines[2] : lines[1]) || '';
    const time = ti > 0 ? lines[ti] : '';
    const rest = lines.filter((l, i) => i > 1 && i !== ti && l !== subject).join(' ');
    const key = from + '|' + subject + '|' + time; if (seen.has(key)) continue; seen.add(key);
    entries.push({ from, subject, time, snippet: rest.slice(0, 240), unread: /^unread\b/i.test(label) || /\bunread\b/i.test(label.slice(0, 40)) });
  }
  let unread = null;
  const folder = [...document.querySelectorAll('[role="treeitem"]')].find(n => /^\s*inbox\b/i.test(n.getAttribute('aria-label') || n.innerText || ''));
  if (folder) { const m = (folder.getAttribute('aria-label') || folder.innerText).match(/(\d+)\s*(unread)?/i); if (m) unread = Number(m[1]); }
  if (unread == null) unread = entries.filter(e => e.unread).length;
  const who = (document.title.match(/^Mail\s*-\s*(.+?)\s*-\s*Outlook/i) || [])[1] || '';
  return { ok: true, who, unread, entries, raw: entries.length ? '' : ((document.querySelector('[role="main"]') || document.body)?.innerText || '').slice(0, 3000) };
}
// Runs inside the Outlook calendar tab (work week view).
async function readOutlookCalendar() {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const T = '(\\d{1,2}:\\d{2}(?:\\s?[AP]M)?)';
  const timed = new RegExp(`^(.*?),\\s*${T}\\s+(?:to|-|–)\\s+${T},\\s*(?:\\w+,\\s*)?(\\w+ \\d{1,2},? \\d{4})`, 'i');
  const allDay = /^(.*?),\s*all day event,\s*(?:\w+,\s*)?(\w+ \d{1,2},? \d{4})/i;
  let labels = [];
  for (let i = 0; i < 30; i++) {
    labels = [...document.querySelectorAll('[role="button"][aria-label], [data-calitemid][aria-label]')].map(e => e.getAttribute('aria-label'));
    if (labels.some(l => timed.test(l) || allDay.test(l)) || (i > 10 && document.querySelector('[role="grid"], [role="main"]'))) break;
    await wait(500);
  }
  const events = [], seen = new Set();
  for (const l of labels) {
    let m = l.match(timed), ev = null;
    if (m) ev = { title: m[1], date: m[4], time: m[2], end: m[3], allDay: false, info: l.slice(m[0].length).replace(/^,\s*/, '').slice(0, 160) };
    else if ((m = l.match(allDay))) ev = { title: m[1], date: m[2], time: '', allDay: true, info: '' };
    if (!ev || seen.has(ev.title + ev.date + ev.time)) continue;
    seen.add(ev.title + ev.date + ev.time); events.push(ev);
  }
  // Older Outlook servers label things differently: if nothing matched, hand over the page text so the assistant can still read it.
  return { ok: true, events, raw: events.length ? '' : ((document.querySelector('[role="main"]') || document.body)?.innerText || '').slice(0, 3000) };
}
async function outlook() {
  // Default is Microsoft 365; an organization's own server can be set per computer (System → Apps → Outlook).
  const base = 'https://outlook.office.com';
  const mailUrl = appConfig?.outlook?.mail || base + '/mail/inbox';
  const calUrl = appConfig?.outlook?.calendar || (appConfig?.outlook?.mail ? appConfig.outlook.mail.replace(/#path=\/mail.*$|\/mail.*$/i, m => m.startsWith('#') ? '#path=/calendar/view/workweek' : '/calendar/view/workweek') : base + '/calendar/view/workweek');
  const mailTab = await ownTab('Outlook mail', mailUrl);
  const [{ result: mail } = {}] = await chrome.scripting.executeScript({ target: { tabId: mailTab.id }, func: readOutlookMail });
  if (!mail?.ok) throw new Error("couldn't read the Outlook inbox; retrying next minute");
  const now = new Date();
  const when = t => {
    if (!t) return null;
    if (/^\d{1,2}:\d{2}/.test(t)) { const d = Date.parse(`${now.toDateString()} ${t}`); return isNaN(d) ? null : d; }
    if (/^yesterday/i.test(t)) return now.getTime() - 864e5;
    const d = Date.parse(/\d{4}/.test(t) ? t : `${t} ${now.getFullYear()}`); return isNaN(d) ? null : d;
  };
  let events = [], calError = null, calRaw = '';
  try {
    const calTab = await ownTab('Outlook calendar', calUrl);
    const [{ result: cal } = {}] = await chrome.scripting.executeScript({ target: { tabId: calTab.id }, func: readOutlookCalendar });
    calRaw = cal?.raw || '';
    events = (cal?.events || []).map(e => {
      const at = e.allDay ? Date.parse(e.date) : Date.parse(`${e.date} ${e.time}`);
      return { title: e.title, date: e.date, time: e.time, end: e.end || '', info: e.info, allDay: e.allDay, at: isNaN(at) ? null : at, link: calUrl, source: 'outlook' };
    }).sort((a, b) => (a.at || 0) - (b.at || 0));
  } catch (e) { calError = String(e.message || e); }
  return {
    who: mail.who, unread: mail.unread, calendarError: calError,
    entries: mail.entries.map(e => ({ subject: e.subject, snippet: e.snippet, from: e.from, at: when(e.time) || Date.now(), unread: e.unread, link: mailUrl, source: 'outlook' })),
    events, raw: mail.raw, calendarRaw: calRaw,
  };
}

/* ---------- sync to the agent ---------- */
let syncing = null;
function sync() {
  syncing ||= (async () => {
    const s = await settings();
    const out = { errors: {}, version: chrome.runtime.getManifest().version };
    const grab = async (key, fn) => { try { out[key] = await fn(); } catch (e) { out.errors[key] = String(e.message || e); } };
    // Only the apps chosen for this computer: turned-off apps are not read and get no pinned tab.
    if (appOn('gmail')) await grab('gmail', gmail);
    await Promise.all([
      appOn('gcal') ? grab('calendar', () => calendar(s.email || out.gmail?.email)) : null,
      appOn('slack') ? grab('slack', () => slackTabRun(null)) : null,
      appConfig?.apps?.outlook === true ? grab('outlook', outlook) : null,
      grab('tabs', async () => (await listTabs()).filter(t => allowedUrl(t.url).ok)),
    ]);
    let ok = false;
    try {
      const r = await toAgent('/bridge/ingest', { method: 'POST', body: JSON.stringify(out) });
      ok = r.ok;
      if (ok) setConfig((await r.json().catch(() => ({}))).config);
      if (!ok) out.errors.agent = `agent said ${r.status}`;
    } catch (e) { out.errors.agent = /fetch/i.test(e.message) ? 'the Aura agent is not running on this computer' : e.message; }
    const detail = { outlook: out.outlook ? `${out.outlook.unread} unread, ${out.outlook.events.length} events` : out.errors.outlook, gmail: out.gmail ? `${out.gmail.unread} unread` : out.errors.gmail, calendar: out.calendar ? `${out.calendar.events.length} events` : out.errors.calendar, slack: out.slack ? `${out.slack.mentions.length} mentions` : out.errors.slack, ...(out.errors.agent ? { agent: out.errors.agent } : {}) };
    await chrome.storage.local.set({ lastRun: { at: Date.now(), ok, detail } });
  })().finally(() => { syncing = null; });
  return syncing;
}

/* ---------- which apps this computer uses (set in Aura → System → Apps; sent by the agent) ---------- */
let appConfig = null;
chrome.storage.local.get('appConfig').then(r => { appConfig ||= r.appConfig || null; });
function setConfig(c) {
  if (!c || !c.apps) return;
  appConfig = c; chrome.storage.local.set({ appConfig: c });
  maybeSelfUpdate(c.bridgeVersion);
}
// When Aura is updated, the installer writes the new extension files into this extension's folder;
// reload once to start using them (no clicking reload in chrome://extensions).
const newer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
async function maybeSelfUpdate(v) {
  if (!v || !newer(v, chrome.runtime.getManifest().version)) return;
  const { reloadedFor } = await chrome.storage.local.get('reloadedFor');
  if (reloadedFor === v) return; // already tried: this copy is loaded from an old folder
  await chrome.storage.local.set({ reloadedFor: v });
  chrome.runtime.reload();
}
const appOn = id => appConfig?.apps?.[id] !== false;
function allowedUrl(url) {
  if (!appConfig || !/^https?:\/\//i.test(url || '')) return { ok: true };
  const host = String(url).replace(/^https?:\/\//, '');
  for (const [id, re] of Object.entries(appConfig.matchers || {})) if (new RegExp(re, 'i').test(host)) return appConfig.apps[id] === false ? { ok: false, why: `That app is turned off for this computer in Aura.` } : { ok: true };
  return appConfig.otherSites === false ? { ok: false, why: 'Only the apps chosen for this computer can be read.' } : { ok: true };
}

/* ---------- general web-app access: list, read and (with approval) act in tabs ---------- */
const readable = t => /^https?:/.test(t.url || '');
async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter(readable).map(t => ({ tabId: t.id, title: (t.title || '').slice(0, 120), url: (t.url || '').slice(0, 300), active: t.active }));
}
function waitLoaded(tabId, ms = 20000) {
  return new Promise(resolve => {
    const done = () => { chrome.tabs.onUpdated.removeListener(on); clearTimeout(timer); setTimeout(resolve, 1200); }; // let the app render
    const on = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const timer = setTimeout(done, ms);
    chrome.tabs.onUpdated.addListener(on);
    chrome.tabs.get(tabId).then(t => { if (t.status === 'complete') done(); }).catch(done);
  });
}
// Runs inside the page: visible text plus numbered interactive elements Claude can refer to.
function snapshotPage(find) {
  const visible = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const els = [...document.querySelectorAll('a[href],button,input,textarea,select,[role=button],[role=link],[role=textbox],[contenteditable=true],[role=tab],[role=menuitem],[role=option]')].filter(visible).slice(0, 150);
  const items = els.map((el, i) => {
    el.setAttribute('data-aura-ref', String(i + 1));
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.getAttribute('href') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const kind = el.matches('input,textarea,[role=textbox],[contenteditable=true]') ? 'field' : el.tagName === 'A' ? 'link' : 'button';
    return `[${i + 1}] ${kind}: ${label}`;
  });
  let text = (document.querySelector('main,[role=main]') || document.body).innerText.replace(/\n{3,}/g, '\n\n');
  if (find) {
    const lines = text.split('\n'); const want = find.toLowerCase();
    const hits = lines.map((l, i) => l.toLowerCase().includes(want) ? lines.slice(Math.max(0, i - 3), i + 6).join('\n') : null).filter(Boolean);
    text = hits.length ? hits.slice(0, 15).join('\n---\n') : `(no lines contain "${find}")\n` + text.slice(0, 4000);
  }
  return { title: document.title, url: location.href, text: text.slice(0, 16000), elements: items.join('\n').slice(0, 8000) };
}
function actInPage(ref, action, text) {
  const el = document.querySelector(`[data-aura-ref="${CSS.escape(String(ref))}"]`);
  if (!el) return { ok: false, error: `No element [${ref}] — read the page again first.` };
  el.scrollIntoView({ block: 'center' });
  if (action === 'click') { el.click(); return { ok: true }; }
  if (action === 'type') {
    el.focus();
    if (el.isContentEditable) { document.execCommand('selectAll', false); document.execCommand('insertText', false, text); }
    else { const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set; set ? set.call(el, text) : (el.value = text); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
    return { ok: true };
  }
  if (action === 'press_enter') {
    el.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    el.form?.requestSubmit?.();
    return { ok: true };
  }
  return { ok: false, error: 'action must be click, type or press_enter' };
}
async function inTab(tabId, func, args) {
  const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result;
}
async function readJob({ tabId, url, find }) {
  let tab;
  if (tabId) tab = await chrome.tabs.get(Number(tabId));
  else if (url) {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) pages can be read.');
    { const a = allowedUrl(url); if (!a.ok) throw new Error(a.why); }
    const want = url.replace(/[#?].*$/, '');
    tab = (await chrome.tabs.query({})).find(t => (t.url || '').startsWith(want));
    if (!tab) { tab = await chrome.tabs.create({ url, active: false }); await waitLoaded(tab.id); tab = await chrome.tabs.get(tab.id); }
  } else throw new Error('Give a tabId or a url.');
  if (!readable(tab)) throw new Error('That tab is not a web page.');
  const allowed = allowedUrl(tab.url); if (!allowed.ok) throw new Error(allowed.why);
  const snap = await inTab(tab.id, snapshotPage, [find || '']);
  return { tabId: tab.id, ...snap };
}
async function actJob({ tabId, ref, action, text }) {
  const allowed = allowedUrl((await chrome.tabs.get(Number(tabId))).url); if (!allowed.ok) throw new Error(allowed.why);
  const r = await inTab(Number(tabId), actInPage, [String(ref), action, String(text || '')]);
  if (!r?.ok) throw new Error(r?.error || 'action failed');
  await new Promise(res => setTimeout(res, 1500));
  const after = await inTab(Number(tabId), snapshotPage, ['']);
  return { ok: true, after: { title: after.title, url: after.url, text: after.text.slice(0, 3000) } };
}
async function runJob(job) {
  if (job.kind === 'tabs') return { tabs: await listTabs() };
  if (job.kind === 'read') return readJob(job.input || {});
  if (job.kind === 'act') return actJob(job.input || {});
  if (job.kind === 'slack_send') return (await slackTabRun(job.input)).result;
  if (job.kind === 'resync') { await sync(); return (await chrome.storage.local.get('lastRun')).lastRun; }
  throw new Error('unknown job ' + job.kind);
}

/* ---------- jobs from the agent (long-poll) ---------- */
let polling = false;
async function pollJobs() {
  if (polling) return;
  polling = true;
  try {
    for (let i = 0; i < 12; i++) { // ~5 minutes, then the alarm restarts it
      let jobs = [];
      try {
        const r = await toAgent('/bridge/jobs');
        if (!r.ok) return;
        const body = await r.json(); jobs = body.jobs || []; setConfig(body.config);
      } catch { return; }
      for (const job of jobs) {
        let reply;
        try { reply = { id: job.id, ok: true, result: await runJob(job) }; }
        catch (e) { reply = { id: job.id, ok: false, error: String(e.message || e) }; }
        await toAgent('/bridge/result', { method: 'POST', body: JSON.stringify(reply) }).catch(() => {});
      }
    }
  } finally { polling = false; }
}

chrome.alarms.create('sync', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => { sync(); pollJobs(); });
chrome.runtime.onStartup.addListener(() => { sync(); pollJobs(); });
chrome.runtime.onInstalled.addListener(() => { sync(); pollJobs(); });
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'sync') { sync().then(() => reply({ ok: true })); pollJobs(); return true; }
});
