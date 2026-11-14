// Relay Bridge: every minute, read Gmail (unread), Google Calendar (agenda) and Slack (mentions)
// using this Chrome's own sign-in, and hand the result to the Relay agent on this computer.
// It also waits for jobs from the agent (sending a Slack message the user approved on their phone).
// No passwords or Slack tokens are stored: Slack calls run inside the open Slack tab.

const decode = s => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const settings = () => chrome.storage.local.get(['agent', 'token', 'email']).then(s => ({ agent: s.agent || 'http://127.0.0.1:8101', token: s.token || '', email: s.email || '' }));

// Connect to the agent on this computer without any copy-pasting: the agent hands its token only
// to a request whose Origin is a browser extension, which web pages can't fake.
async function ensureToken() {
  const s = await settings();
  if (s.token) return s;
  const r = await fetch(s.agent + '/bridge/hello', { method: 'POST' });
  if (!r.ok) throw new Error(r.status === 403 ? 'browser access is switched off in the agent' : 'agent said ' + r.status);
  const { token } = await r.json();
  await chrome.storage.local.set({ token });
  return { ...s, token };
}
async function toAgent(path, opts = {}) {
  let s = await ensureToken();
  const go = () => fetch(s.agent + path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Relay-Bridge': s.token, ...(opts.headers || {}) } });
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
async function fetchSignedIn(url, { name, tabPattern, good }) {
  try {
    const r = await fetch(url, { credentials: 'include' });
    const res = { ok: r.ok, status: r.status, url: r.url, text: await r.text() };
    if (good(res)) return res;
  } catch {}
  const [tab] = await chrome.tabs.query({ url: tabPattern });
  if (!tab) throw new Error(`not signed in from the extension; open ${name} in a tab`);
  const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: fetchInPage, args: [url] });
  if (result && !result.error && good(result)) return result;
  throw new Error(`not signed in to ${name}`);
}

/* ---------- Gmail: unread inbox from the Atom feed ---------- */
const tag = (x, t) => decode((x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '');
async function gmail() {
  const x = (await fetchSignedIn('https://mail.google.com/mail/u/0/feed/atom', { name: 'Gmail', tabPattern: 'https://mail.google.com/*', good: r => r.ok && /<feed/.test(r.text) })).text;
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
    name: 'Google Calendar', tabPattern: 'https://calendar.google.com/*',
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
async function slackTabRun(job) {
  const [tab] = await chrome.tabs.query({ url: 'https://app.slack.com/*' });
  if (!tab) throw new Error('open Slack (app.slack.com) in a Chrome tab');
  const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: slackInPage, args: [job || null] });
  if (!result?.ok) throw new Error(result?.error || 'the Slack tab did not answer; reload it');
  return result;
}

/* ---------- sync to the agent ---------- */
let syncing = null;
function sync() {
  syncing ||= (async () => {
    const s = await settings();
    const out = { errors: {} };
    const grab = async (key, fn) => { try { out[key] = await fn(); } catch (e) { out.errors[key] = String(e.message || e); } };
    await grab('gmail', gmail);
    await Promise.all([grab('calendar', () => calendar(s.email || out.gmail?.email)), grab('slack', () => slackTabRun(null)), grab('tabs', listTabs)]);
    let ok = false;
    try {
      const r = await toAgent('/bridge/ingest', { method: 'POST', body: JSON.stringify(out) });
      ok = r.ok;
      if (!ok) out.errors.agent = `agent said ${r.status}`;
    } catch (e) { out.errors.agent = /fetch/i.test(e.message) ? 'the Relay agent is not running on this computer' : e.message; }
    const detail = { gmail: out.gmail ? `${out.gmail.unread} unread` : out.errors.gmail, calendar: out.calendar ? `${out.calendar.events.length} events` : out.errors.calendar, slack: out.slack ? `${out.slack.mentions.length} mentions` : out.errors.slack, ...(out.errors.agent ? { agent: out.errors.agent } : {}) };
    await chrome.storage.local.set({ lastRun: { at: Date.now(), ok, detail } });
  })().finally(() => { syncing = null; });
  return syncing;
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
    el.setAttribute('data-relay-ref', String(i + 1));
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
  const el = document.querySelector(`[data-relay-ref="${CSS.escape(String(ref))}"]`);
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
    const want = url.replace(/[#?].*$/, '');
    tab = (await chrome.tabs.query({})).find(t => (t.url || '').startsWith(want));
    if (!tab) { tab = await chrome.tabs.create({ url, active: false }); await waitLoaded(tab.id); tab = await chrome.tabs.get(tab.id); }
  } else throw new Error('Give a tabId or a url.');
  if (!readable(tab)) throw new Error('That tab is not a web page.');
  const snap = await inTab(tab.id, snapshotPage, [find || '']);
  return { tabId: tab.id, ...snap };
}
async function actJob({ tabId, ref, action, text }) {
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
        ({ jobs = [] } = await r.json());
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
