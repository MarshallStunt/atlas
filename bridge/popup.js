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
  $('apps').innerHTML = Object.entries(lastRun?.apps || {}).filter(([, a]) => a.state !== 'off') // turned-off apps aren't shown
    .map(([n, a]) => `<div class="app ${a.state}"><span class="dot"></span><div><div class="n">${esc(n)}</div><div class="t" title="${esc(a.text)}">${esc(a.text)}</div></div></div>`).join('')
    || '<div class="app"><div class="t">Apps appear here after the first sync.</div></div>';
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
