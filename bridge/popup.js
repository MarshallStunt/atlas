// Atlas Bridge popup: what's connected in this browser, and quick actions.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

async function show() {
  const { lastRun, appConfig, space, agent } = await chrome.storage.local.get(['lastRun', 'appConfig', 'space', 'agent']);
  const name = appConfig?.space || space;
  $('space').hidden = !name; $('space').textContent = name || '';
  $('agent').value = agent || '';
  const st = $('status');
  if (!lastRun) { st.className = 'status'; $('statusText').textContent = 'Not synced yet'; }
  else if (!lastRun.ok) { st.className = 'status bad'; $('statusText').textContent = lastRun.agentError || 'Not connected to Atlas on this computer'; }
  else { st.className = 'status ok'; $('statusText').textContent = 'Connected to Atlas'; }
  $('when').textContent = lastRun ? 'Last sync ' + ago(lastRun.at) : '';
  // Exactly the apps that are on for this space. Synced apps show their sync status; the others show
  // whether they're open in this browser (the assistant can read them when you ask).
  const catalog = appConfig?.catalog || [];
  if (!catalog.length) { $('apps').innerHTML = '<div class="app"><div class="t">Apps appear here after the first sync.</div></div>'; return; }
  const on = catalog.filter(a => appConfig.apps?.[a.id] === true);
  const statusName = { gmail: 'Gmail', gcal: 'Google Calendar', slack: 'Slack', outlook: 'Outlook' };
  const tabs = await chrome.tabs.query({});
  const isOpen = a => { try { const re = new RegExp(appConfig.matchers?.[a.id] || '^$', 'i'); return tabs.some(t => re.test(String(t.url || '').replace(/^https?:\/\//, ''))); } catch { return false; } };
  const row = (cls, name, text) => `<div class="app ${cls}"><span class="dot"></span><div><div class="n">${esc(name)}</div><div class="t" title="${esc(text)}">${esc(text)}</div></div></div>`;
  const synced = on.filter(a => a.synced).map(a => { const st = lastRun?.apps?.[statusName[a.id]]; return row(st?.state || 'warn', a.name, st?.text || 'Waiting for the first sync'); });
  const others = on.filter(a => !a.synced).map(a => isOpen(a) ? row('ok', a.name, 'Open: Atlas can read it when you ask') : row('idle', a.name, 'Not open in this browser'));
  if (appConfig.otherSites) others.push(row('idle', 'Other websites', 'Any other open site, when you ask'));
  $('apps').innerHTML = (synced.length ? `<div class="group">Synced</div>${synced.join('')}` : '') + (others.length ? `<div class="group">Ready when you ask</div>${others.join('')}` : '')
    || '<div class="app"><div class="t">No apps are on for this space. Turn some on in Atlas → System → Apps.</div></div>';
}
$('sync').onclick = async () => { $('sync').textContent = 'Syncing…'; await chrome.runtime.sendMessage({ type: 'sync' }).catch(() => {}); $('sync').textContent = '↻ Sync now'; show(); };
$('open').onclick = async () => { const { appConfig } = await chrome.storage.local.get('appConfig'); chrome.tabs.create({ url: appConfig?.hubUrl || 'http://127.0.0.1:8100' }); window.close(); };
$('save').onclick = async () => {
  const agent = $('agent').value.trim().replace(/\/$/, '');
  await chrome.storage.local.set({ agent });
  if (agent) await chrome.storage.local.remove('token'); // a different agent: connect fresh
  $('save').textContent = 'Saved'; setTimeout(() => ($('save').textContent = 'Save'), 1200);
};
chrome.storage.onChanged.addListener(show);
show();
