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
  else if (!lastRun.ok) {
    st.className = 'status bad';
    $('statusText').innerHTML = `<b>${esc((t => t.charAt(0).toUpperCase() + t.slice(1))(lastRun.agentError || 'Not connected to Atlas on this computer'))}</b><div class="help">Atlas starts by itself when you log in. To start it now, open the <b>Atlas</b> app on this computer, then tap Retry.</div><div class="mini"><button data-retry>Retry</button><button data-openatlas>Open Atlas</button></div>`;
  }
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
  // Each row has the one action that helps: sign in, retry, open, or show its tab.
  const row = (cls, name, text, id, act) => `<div class="app ${cls}${act ? ' click' : ''}" ${act ? `data-app="${esc(id)}" data-act="${act}" role="button" tabindex="0"` : ''}><span class="dot"></span><div class="body"><div class="n">${esc(name)}</div><div class="t" title="${esc(text)}">${esc(text)}</div></div>${act ? `<span class="act">${{ signin: 'Sign in', retry: 'Retry', open: 'Open', show: 'Show' }[act]} ›</span>` : ''}</div>`;
  const synced = on.filter(a => a.synced).map(a => {
    const st = lastRun?.apps?.[statusName[a.id]], state = st?.state || 'warn';
    return row(state, a.name, st?.text || 'Waiting for the first sync', a.id, state === 'signin' ? 'signin' : state === 'warn' ? 'retry' : 'show');
  });
  const others = on.filter(a => !a.synced).map(a => isOpen(a) ? row('ok', a.name, 'Open: Atlas can read it when you ask', a.id, 'show') : row('idle', a.name, 'Not open in this browser', a.id, 'open'));
  if (appConfig.otherSites) others.push(row('idle', 'Other websites', 'Any other open site, when you ask'));
  $('apps').innerHTML = (synced.length ? `<div class="group">Synced</div>${synced.join('')}` : '') + (others.length ? `<div class="group">Ready when you ask</div>${others.join('')}` : '')
    || '<div class="app"><div class="t">No apps are on for this space. Turn some on in Atlas → System → Apps.</div></div>';
}
// Bring up the app's tab (Atlas's own pinned one first), or open the app if it isn't open.
async function focusOrOpen(id, forceOpen) {
  const { appConfig } = await chrome.storage.local.get('appConfig');
  const app = (appConfig?.catalog || []).find(a => a.id === id); if (!app) return;
  const re = new RegExp(appConfig.matchers?.[id] || '^$', 'i');
  const tabs = (await chrome.tabs.query({})).filter(t => re.test(String(t.url || '').replace(/^https?:\/\//, '')));
  const tab = tabs.find(t => t.pinned) || tabs[0];
  if (tab && !forceOpen) { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); }
  else await chrome.tabs.create({ url: app.url, active: true });
  window.close();
}
async function syncNow(label) {
  const b = $('sync'); b.textContent = label || 'Syncing…'; b.disabled = true;
  await chrome.runtime.sendMessage({ type: 'sync' }).catch(() => {});
  b.textContent = '↻ Sync now'; b.disabled = false; show();
}
document.addEventListener('click', e => {
  const r = e.target.closest('[data-act]');
  if (r) { const act = r.dataset.act; if (act === 'retry') return syncNow('Retrying…'); return focusOrOpen(r.dataset.app, act === 'open'); }
  if (e.target.closest('[data-retry]')) return syncNow('Connecting…');
  if (e.target.closest('[data-openatlas]')) return $('open').click();
});
document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-act]')) { e.preventDefault(); e.target.click(); } });
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
