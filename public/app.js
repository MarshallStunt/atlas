// Relay phone UI. Everything shown comes from /api/state; everything from email, Slack and the
// calendar is untrusted text, so it is always escaped before it reaches the page.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeHref = u => /^https?:\/\//i.test(String(u || '')) ? esc(u) : '#';
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
let state = null, view = 'now', speakReplies = false, lastWasVoice = false;

/* ---------------- api ---------------- */
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') { showLogin(); throw new Error('Signed out'); }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------------- time helpers ---------------- */
function rel(ms) {
  const d = ms - Date.now(), a = Math.abs(d), m = Math.round(a / 60000);
  const s = m < 1 ? 'now' : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
  return s === 'now' ? 'now' : d > 0 ? `in ${s}` : `${s} ago`;
}
const clock = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const isToday = ms => new Date(ms).toDateString() === new Date().toDateString();

/* ---------------- sign-in ---------------- */
let setupMode = false;
async function boot() {
  const s = await fetch('/api/session').then(r => r.json());
  if (s.authed) return showMain();
  showLogin(s);
}
function showLogin(s = {}) {
  $('#main').hidden = true; $('#login').hidden = false;
  setupMode = !!s.canSetup;
  $('#pin2').hidden = !setupMode;
  $('#login-btn').textContent = setupMode ? 'Set PIN' : 'Unlock';
  $('#login-hint').textContent = setupMode ? 'Choose a 6–12 digit PIN for your phone' : s.needsSetup ? 'Set up Relay from your computer first: open http://127.0.0.1:8100 there.' : 'Enter your PIN';
  $('#pin').focus();
}
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#login-error').textContent = '';
  const pin = $('#pin').value.trim();
  try {
    if (setupMode) {
      if (pin !== $('#pin2').value.trim()) throw new Error('The PINs don\'t match.');
      await api('/api/setup', { method: 'POST', body: { pin } });
    } else await api('/api/login', { method: 'POST', body: { pin } });
    $('#pin').value = $('#pin2').value = '';
    showMain();
  } catch (err) { $('#login-error').textContent = err.message; }
});

async function showMain() {
  $('#login').hidden = true; $('#main').hidden = false;
  await refresh();
  loadHistory();
  setInterval(() => document.visibilityState === 'visible' && refresh(true), 20000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh(true));
}

/* ---------------- state ---------------- */
// Background refreshes leave the Devices page alone so they never wipe what you're typing there.
async function refresh(background = false) {
  try { state = await api('/api/state'); } catch { return; }
  speakReplies = state.settings.voiceReplies;
  $('#speak-toggle').checked = speakReplies;
  renderHeader(); renderApprovals();
  if (view === 'now') renderNow();
  if (view === 'more' && !background) renderMore();
}
const device = () => state?.devices.find(d => d.selected);

function renderHeader() {
  const d = device();
  $('#device-name').textContent = d ? d.name : 'No computer paired';
  $('#device-pill .dot').classList.toggle('on', !!d?.online);
  const at = state.snapshot?.receivedAt;
  $('#updated').textContent = d && !d.online ? 'offline' : at ? `updated ${rel(at)}` : '';
}

function renderApprovals() {
  const list = state?.approvals || [];
  $('#approvals').innerHTML = list.map(a => `
    <div class="approval" data-id="${esc(a.id)}">
      <b>Approve? ${esc(a.summary)}</b>
      <div class="dim">Relay wants to do this on your computer.</div>
      <pre>${esc(a.tool === 'slack_send' ? `To: ${a.input.to}\n\n${a.input.text}` : a.tool === 'run_command' ? `$ ${a.input.command}` : a.tool === 'browser_act' ? `${a.input.action} [${a.input.ref}]${a.input.text ? `\n\n${a.input.text}` : ''}` : JSON.stringify(a.input, null, 2))}</pre>
      <div class="actions"><button class="btn primary" data-approve="1">Approve</button><button class="btn" data-approve="0">Deny</button></div>
    </div>`).join('');
}
$('#approvals').addEventListener('click', async e => {
  const b = e.target.closest('[data-approve]'); if (!b) return;
  const id = b.closest('.approval').dataset.id;
  b.closest('.approval').querySelectorAll('button').forEach(x => x.disabled = true);
  try { await api(`/api/approvals/${id}`, { method: 'POST', body: { approve: b.dataset.approve === '1' } }); toast(b.dataset.approve === '1' ? 'Approved' : 'Denied'); }
  catch (err) { toast(err.message); }
  refresh();
});

/* ---------------- Now ---------------- */
function renderNow() {
  const snap = state.snapshot, d = device();
  const el = $('#now-cards');
  if (!d) {
    el.innerHTML = `<div class="card hero"><div class="big">Pair your computer</div><p class="dim">On the computer, run <b>npm run agent</b> in the Relay folder. It shows a code; enter it under Devices.</p><div class="actions"><button class="btn primary" data-goto="more">Go to Devices</button></div></div>`;
    return;
  }
  if (!snap) { el.innerHTML = `<div class="card"><p class="dim">Waiting for the first update from ${esc(d.name)}…</p></div>`; return; }
  const inbox = snap.inbox || {}, comp = snap.computer || {};
  const now = Date.now();
  const events = (inbox.calendar?.events || []).filter(e => e.at && !e.allDay);
  const next = events.find(e => e.at > now - 10 * 60000);
  const today = (inbox.calendar?.events || []).filter(e => e.at && isToday(e.at));
  const cards = [];

  // Next meeting
  if (next) {
    const live = next.at <= now;
    cards.push(`<div class="card hero"><h2>${live ? 'Happening now' : 'Next meeting'}</h2>
      <div class="big">${esc(next.title)}</div>
      <div><span class="when">${live ? 'started ' + rel(next.at) : rel(next.at)}</span> <span class="dim">· ${esc(next.time || clock(next.at))}${isToday(next.at) ? '' : ' · ' + esc(next.date)}</span></div>
      ${comp.inCall ? `<div class="warn-line">You are in a ${esc(comp.inCall)} call on the computer.</div>` : ''}
      <div class="actions"><a class="btn" href="${safeHref(next.link)}" target="_blank" rel="noopener">Open on phone</a><button class="btn" data-open="${esc(next.link)}">Open on computer</button></div></div>`);
  } else if (inbox.calendar) {
    cards.push(`<div class="card hero"><h2>Calendar</h2><div class="big">No more meetings today</div></div>`);
  }

  // Agenda
  if (inbox.calendar) {
    cards.push(`<div class="card"><div class="card-head"><h2>Today</h2><span class="count">${today.length}</span></div>
      ${today.length ? today.map(e => {
        const cls = e.at < now - 60 * 60000 ? 'past' : e.at <= now && e.at > now - 60 * 60000 ? 'now' : '';
        return `<a class="row ${cls}" href="${safeHref(e.link)}" target="_blank" rel="noopener"><div class="time">${esc(e.allDay ? 'all day' : clock(e.at))}</div><div class="main"><div class="title">${esc(e.title)}</div></div></a>`;
      }).join('') : '<div class="empty">Nothing on the calendar today.</div>'}</div>`);
  }

  // Email
  if (inbox.gmail) {
    const mails = inbox.gmail.latest || [];
    cards.push(`<div class="card"><div class="card-head"><h2>Email</h2><span class="count">${inbox.gmail.unread} unread</span></div>
      ${mails.slice(0, 6).map(m => `<a class="row" href="${safeHref(m.link)}" target="_blank" rel="noopener"><div class="main"><div class="title">${esc(m.from || m.fromEmail)} — ${esc(m.subject)}</div><div class="sub">${esc(m.snippet)}</div></div><div class="time">${esc(rel(m.at))}</div></a>`).join('') || '<div class="empty">Inbox zero.</div>'}
      <div class="actions"><button class="btn" data-ask="Summarize my unread email. What needs a reply?">Summarize</button></div></div>`);
  }

  // Slack
  if (inbox.slack) {
    const ms = inbox.slack.mentions || [];
    cards.push(`<div class="card"><div class="card-head"><h2>Slack</h2><span class="count">${ms.length}</span></div>
      ${ms.slice(0, 6).map(m => `<a class="row" href="${safeHref(m.link)}" target="_blank" rel="noopener"><div class="main"><div class="title">${esc(m.user)} ${m.isDm ? '(DM)' : m.channel ? 'in #' + esc(m.channel) : ''}</div><div class="sub">${esc(m.text)}</div></div><div class="time">${esc(rel(m.at))}</div></a>`).join('') || '<div class="empty">No mentions or DMs in the last 2 days.</div>'}
      <div class="actions"><button class="btn" data-ask="What do people need from me on Slack?">What do they need?</button></div></div>`);
  }

  if (inbox.connected === false || inbox.note) {
    const errs = Object.entries(inbox.errors || {}).map(([k, v]) => `${k}: ${v}`).join(' · ');
    cards.push(`<div class="card"><h2>Calendar, email, chat</h2><p class="dim">${esc(inbox.note || 'The browser extension on the computer has not sent fresh data. Open Chrome, Edge or Brave there.')}${errs ? '<br>' + esc(errs) : ''}</p></div>`);
  } else if (Object.keys(inbox.errors || {}).length) {
    cards.push(`<div class="card"><h2>Sync problems</h2>${Object.entries(inbox.errors).map(([k, v]) => `<div class="warn-line">${esc(k)}: ${esc(v)}</div>`).join('')}</div>`);
  }

  // Computer
  if (comp.host) {
    const b = comp.battery;
    cards.push(`<div class="card"><div class="card-head"><h2>Computer</h2><span class="dim">${esc(comp.host)} · ${esc(comp.platform)}</span></div>
      <div class="stats">
        ${b ? `<div class="stat"><b>${b.percent}%</b><span>${esc(b.onAC ? 'plugged in' : 'on battery')}</span></div>` : ''}
        <div class="stat"><b>${esc(comp.frontWindow || '—')}</b><span>in front</span></div>
        <div class="stat"><b>${comp.idleSeconds == null ? '—' : comp.idleSeconds < 60 ? 'active' : rel(Date.now() - comp.idleSeconds * 1000).replace(' ago', '')}</b><span>${comp.idleSeconds != null && comp.idleSeconds >= 60 ? 'idle' : 'user'}</span></div>
        <div class="stat"><b>${comp.memoryUsedPct}%</b><span>memory used</span></div>
        ${comp.disk ? `<div class="stat"><b>${comp.disk.freeGB} GB</b><span>disk free</span></div>` : ''}
      </div>
      <div class="chips">${(comp.apps || []).slice(0, 14).map(a => `<span class="chip">${esc(a)}</span>`).join('')}</div>
      <div class="actions"><button class="btn" data-action="lock_computer">Lock screen</button><button class="btn" data-notify>Send a note to screen</button><button class="btn" data-goto="screen">View screen</button></div></div>`);
  } else if (comp.note) cards.push(`<div class="card"><h2>Computer</h2><p class="dim">${esc(comp.note)}</p></div>`);

  // Notes
  const notes = state.notes || [];
  cards.push(`<div class="card"><div class="card-head"><h2>Notes</h2><span class="count">${notes.filter(n => !n.done).length}</span></div>
    ${notes.slice(0, 12).map(n => `<div class="note ${n.done ? 'done' : ''}" data-note="${esc(n.id)}"><input type="checkbox" ${n.done ? 'checked' : ''} aria-label="Done"><span>${esc(n.text)}</span><button aria-label="Delete">×</button></div>`).join('')}
    <form class="inline-form" id="note-form"><input id="note-input" placeholder="Add a note…"><button class="btn">Add</button></form></div>`);

  el.innerHTML = cards.join('');
}

$('#now-cards').addEventListener('click', async e => {
  const t = e.target;
  const go = t.closest('[data-goto]'); if (go) return switchView(go.dataset.goto);
  const ask = t.closest('[data-ask]'); if (ask) { switchView('ask'); return send(ask.dataset.ask); }
  const open = t.closest('[data-open]'); if (open) return action('open_on_computer', { url: open.dataset.open }, 'Opened on the computer');
  const act = t.closest('[data-action]'); if (act) return action(act.dataset.action, {}, 'Done');
  if (t.closest('[data-notify]')) { const msg = prompt('Message to show on the computer screen:'); if (msg) action('notify_computer', { message: msg }, 'Sent to screen'); return; }
  const note = t.closest('[data-note]');
  if (note) {
    const id = note.dataset.note;
    if (t.matches('input[type=checkbox]')) await api(`/api/notes/${id}`, { method: 'POST', body: { done: t.checked } });
    else if (t.matches('button')) await api(`/api/notes/${id}`, { method: 'DELETE' });
    else return;
    refresh();
  }
});
$('#now-cards').addEventListener('submit', async e => {
  if (e.target.id !== 'note-form') return;
  e.preventDefault();
  const text = $('#note-input').value.trim(); if (!text) return;
  await api('/api/notes', { method: 'POST', body: { text } });
  refresh();
});
async function action(tool, input, ok) {
  try { const r = await api('/api/action', { method: 'POST', body: { tool, input } }); toast(r?.note || ok); }
  catch (err) { toast(err.message); }
}

/* ---------------- Screen ---------------- */
$('#shot-btn').addEventListener('click', async () => {
  const btn = $('#shot-btn'); btn.disabled = true; btn.textContent = 'Capturing…';
  try {
    const r = await api('/api/action', { method: 'POST', body: { tool: 'view_screen' } });
    $('#shot').src = `data:${r.mediaType};base64,${r.image}`; $('#shot').hidden = false;
    $('#shot-note').textContent = r.note || '';
  } catch (err) { $('#shot-note').textContent = err.message; }
  btn.disabled = false; btn.textContent = 'Take screenshot';
});
$('#shot').addEventListener('click', () => $('#shot').classList.toggle('zoom'));

/* ---------------- Devices + settings ---------------- */
async function renderMore() {
  const s = state.settings;
  $('#more').innerHTML = `
    <div class="card"><div class="card-head"><h2>Computers</h2></div>
      ${state.devices.map(d => `<div class="row"><div class="main"><div class="title"><span class="dot ${d.online ? 'on' : ''}" style="display:inline-block"></span> ${esc(d.name)} ${d.selected ? '<span class="count">active</span>' : ''}</div>
        <div class="sub">${esc({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[d.platform] || d.platform)} · paired ${esc(new Date(d.pairedAt).toLocaleDateString())} · ${d.online ? 'online' : 'last seen ' + esc(d.lastSeen ? rel(Date.parse(d.lastSeen)) : 'never')}</div></div>
        <div class="actions" style="margin:0">${d.selected ? '' : `<button class="btn" data-dev="${esc(d.id)}" data-op="select">Use</button>`}<button class="btn danger" data-dev="${esc(d.id)}" data-op="revoke">Remove</button></div></div>`).join('') || '<div class="empty">No computers yet.</div>'}
      <form class="inline-form" id="pair-form"><input id="pair-code" placeholder="Pairing code, e.g. K7Q-42M" autocapitalize="characters" autocomplete="off"><button class="btn primary">Pair</button></form>
      <p class="dim" style="font-size:13px">On the computer, run <b>npm run agent</b> in the Relay folder to get a code. What Relay may do there is set on that computer's agent page.</p></div>

    <div class="card"><h2>Assistant</h2>
      <div class="field"><label for="set-provider">AI provider</label><select id="set-provider">${Object.entries(s.providers).map(([id, p]) => `<option value="${esc(id)}" ${id === s.provider ? 'selected' : ''}>${esc(p.label)}${p.ready ? '' : ' — needs key'}</option>`).join('')}</select></div>
      <div class="field"><label for="set-model">Model</label><input id="set-model" list="model-list" value="${esc(s.model)}" autocomplete="off"><datalist id="model-list"></datalist></div>
      <div class="field" id="key-field"></div>
      <div class="field" id="base-field"></div>
      <div class="field"><label for="set-effort">Effort (Claude; lower answers faster)</label><select id="set-effort">${['low', 'medium', 'high'].map(m => `<option ${m === s.effort ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
      <label class="chip toggle" style="margin:6px 0"><input type="checkbox" id="set-voice" ${s.voiceReplies ? 'checked' : ''}> Speak replies after voice questions</label>
      <div class="actions"><button class="btn primary" id="save-settings">Save</button></div>
      <p class="dim" style="font-size:13px">Keys are stored on the hub only and never sent back to this page. Every provider gets the same tools and the same approval rules.</p></div>

    <div class="card"><div class="card-head"><h2>Activity log</h2><button class="btn" id="load-audit">Show</button></div><div id="audit"></div></div>
    <div class="actions"><button class="btn danger" id="logout">Sign out</button></div>`;
  providerFields(true);
}
function providerFields(keepModel) {
  const s = state.settings, id = $('#set-provider').value, p = s.providers[id];
  $('#key-field').innerHTML = p.local ? '' : `<label for="set-key">${esc(p.label)} API key ${p.hasKey ? '(saved — leave empty to keep)' : ''}</label><input id="set-key" type="password" autocomplete="off" placeholder="${p.hasKey ? '••••••••' : 'paste key'}">`;
  $('#base-field').innerHTML = p.local || id === 'lambda' || id === 'openai' ? `<label for="set-base">Endpoint</label><input id="set-base" value="${esc(p.base)}" autocomplete="off">` : '';
  if (!keepModel) $('#set-model').value = p.models[0] || '';
  $('#model-list').innerHTML = p.models.map(m => `<option value="${esc(m)}">`).join('');
  api('/api/models?provider=' + encodeURIComponent(id)).then(list => { if ($('#set-provider')?.value === id) $('#model-list').innerHTML = list.map(m => `<option value="${esc(m)}">`).join(''); }).catch(() => {});
}
$('#more').addEventListener('change', e => { if (e.target.id === 'set-provider') providerFields(false); });
$('#more').addEventListener('click', async e => {
  const t = e.target;
  const dev = t.closest('[data-dev]');
  if (dev) {
    if (dev.dataset.op === 'revoke' && !confirm('Remove this computer? Its agent will have to pair again.')) return;
    try { await api(`/api/devices/${dev.dataset.dev}/${dev.dataset.op}`, { method: 'POST' }); } catch (err) { toast(err.message); }
    return refresh();
  }
  if (t.id === 'save-settings') {
    const provider = $('#set-provider').value;
    const body = { provider, model: $('#set-model').value.trim(), effort: $('#set-effort').value, voiceReplies: $('#set-voice').checked };
    if ($('#set-key')?.value.trim()) body.keys = { [provider]: $('#set-key').value.trim() };
    if ($('#set-base')) body.baseUrls = { [provider]: $('#set-base').value.trim() };
    try { await api('/api/settings', { method: 'POST', body }); toast('Saved'); refresh(); } catch (err) { toast(err.message); }
  }
  if (t.id === 'load-audit') {
    const rows = await api('/api/audit');
    $('#audit').innerHTML = rows.slice(0, 40).map(r => `<div class="row"><div class="time">${esc(rel(Date.parse(r.at)))}</div><div class="main"><div class="title">${esc(r.event)}${r.tool ? ' · ' + esc(r.tool) : ''}${r.via ? ' <span class="dim">(' + esc(r.via) + ')</span>' : ''}</div>${r.text ? `<div class="sub">${esc(r.text)}</div>` : ''}</div></div>`).join('') || '<div class="empty">Nothing yet.</div>';
  }
  if (t.id === 'logout') { await api('/api/logout', { method: 'POST' }).catch(() => {}); location.reload(); }
});
$('#more').addEventListener('submit', async e => {
  if (e.target.id !== 'pair-form') return;
  e.preventDefault();
  try { const d = await api('/api/devices/pair', { method: 'POST', body: { code: $('#pair-code').value } }); toast(`Paired ${d.name}`); refresh(); }
  catch (err) { toast(err.message); }
});

/* ---------------- Ask (chat) ---------------- */
function addMsg(role, text, cls = '') {
  const el = document.createElement('div');
  el.className = `msg ${role} ${cls}`; el.textContent = text;
  $('#chat').append(el); el.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return el;
}
function addToolLine(text, fail) {
  const el = document.createElement('div'); el.className = 'toolline' + (fail ? ' fail' : ''); el.textContent = text;
  $('#chat').append(el); return el;
}
const TOOL_LABEL = { get_overview: 'Checking your computer', view_screen: 'Looking at the screen', open_on_computer: 'Opening on the computer', draft_email: 'Opening a Gmail draft', notify_computer: 'Showing a notification', lock_computer: 'Locking the screen', slack_send: 'Slack message (needs approval)', run_command: 'Command (needs approval)', browser_tabs: 'Checking browser tabs', browser_read: 'Reading a web app', browser_act: 'Acting in a web app (needs approval)', add_note: 'Adding a note', complete_note: 'Updating notes' };

async function loadHistory() {
  try {
    const h = await api('/api/chat/history');
    $('#chat').innerHTML = '';
    h.forEach(m => addMsg(m.role, m.text));
    $('#suggestions').hidden = h.length > 0;
  } catch {}
}

let sending = false;
async function send(text) {
  text = String(text || '').trim();
  if (!text || sending) return;
  sending = true; $('#suggestions').hidden = true;
  const voice = lastWasVoice; lastWasVoice = false;
  addMsg('user', text);
  let bubble = null, full = '';
  const ensureBubble = () => (bubble ||= addMsg('assistant', '', 'typing'));
  ensureBubble();
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, tz }) });
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'text') { ensureBubble(); full += ev.delta; bubble.textContent += ev.delta; bubble.scrollIntoView({ block: 'end' }); }
        else if (ev.type === 'tool') {
          if (bubble && !bubble.textContent) bubble.remove();
          if (bubble) bubble.classList.remove('typing');
          bubble = null;
          ev.line = addToolLine('⋯ ' + (TOOL_LABEL[ev.name] || ev.name));
          send.lastTool = ev.line;
        }
        else if (ev.type === 'tool_done') { if (send.lastTool) { send.lastTool.textContent = (ev.ok ? '✓ ' : '✕ ') + (TOOL_LABEL[ev.name] || ev.name).replace(' (needs approval)', '') + (ev.ok ? '' : ` — ${ev.error}`); send.lastTool.classList.toggle('fail', !ev.ok); } }
        else if (ev.type === 'approval') { await refresh(); toast('Waiting for your approval'); window.scrollTo({ top: 0, behavior: 'smooth' }); }
        else if (ev.type === 'error') { addMsg('assistant', ev.error, 'error'); }
      }
    }
  } catch (err) { addMsg('assistant', err.message, 'error'); }
  finally {
    if (bubble) { bubble.classList.remove('typing'); if (!bubble.textContent) bubble.remove(); }
    sending = false; refresh(true);
    if (voice && speakReplies && full) speak(full);
  }
}
$('#composer').addEventListener('submit', e => { e.preventDefault(); const v = $('#ask-input').value; $('#ask-input').value = ''; if (view !== 'ask') switchView('ask'); send(v); });
$('#suggestions').addEventListener('click', e => { const b = e.target.closest('.chip'); if (b) send(b.textContent); });
$('#new-chat').addEventListener('click', async () => { await api('/api/chat/reset', { method: 'POST' }); $('#chat').innerHTML = ''; $('#suggestions').hidden = false; });
$('#speak-toggle').addEventListener('change', e => { speakReplies = e.target.checked; api('/api/settings', { method: 'POST', body: { voiceReplies: speakReplies } }).catch(() => {}); });

/* ---------------- voice ---------------- */
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/[*_#`>]/g, '').slice(0, 1200));
  u.rate = 1.05; speechSynthesis.speak(u);
}
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, listening = false;
$('#mic').addEventListener('click', () => {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (!SR) {
    $('#ask-input').focus();
    toast(window.isSecureContext ? 'Voice input is not supported here — use the keyboard\'s dictation key.' : 'Voice needs HTTPS. Open Relay through your Tailscale https address.');
    return;
  }
  if (listening) { rec.stop(); return; }
  rec = new SR();
  rec.lang = navigator.language || 'en-US'; rec.interimResults = true; rec.continuous = false;
  let finalText = '';
  rec.onresult = e => {
    let interim = '';
    for (const r of e.results) (r.isFinal ? (finalText = r[0].transcript) : (interim += r[0].transcript));
    $('#ask-input').value = finalText || interim;
  };
  rec.onerror = e => { if (e.error !== 'no-speech' && e.error !== 'aborted') toast(e.error === 'not-allowed' ? 'Microphone access was blocked.' : 'Voice error: ' + e.error); };
  rec.onend = () => {
    listening = false; $('#mic').classList.remove('listening');
    const text = (finalText || $('#ask-input').value).trim();
    if (text) { $('#ask-input').value = ''; lastWasVoice = true; if (view !== 'ask') switchView('ask'); send(text); }
  };
  rec.start(); listening = true; $('#mic').classList.add('listening');
  if ('vibrate' in navigator) navigator.vibrate(15);
});

/* ---------------- navigation ---------------- */
function switchView(v) {
  view = v;
  document.querySelectorAll('.view').forEach(el => el.hidden = el.id !== `view-${v}`);
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  if (v === 'now') renderNow();
  if (v === 'more') renderMore();
  if (v === 'ask') setTimeout(() => $('#chat').lastElementChild?.scrollIntoView({ block: 'end' }), 50);
  window.scrollTo({ top: 0 });
}
document.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) switchView(b.dataset.view); });
$('#refresh').addEventListener('click', async () => {
  try { await api('/api/action', { method: 'POST', body: { tool: 'get_overview' } }); } catch (err) { toast(err.message); }
  setTimeout(refresh, 400);
});

boot();
