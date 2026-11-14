const $ = id => document.getElementById(id);
async function show() {
  const { lastRun } = await chrome.storage.local.get('lastRun');
  $('status').textContent = lastRun ? `Last sync ${new Date(lastRun.at).toLocaleTimeString()}: ${lastRun.ok ? 'sent to agent' : 'failed'}\n` + Object.entries(lastRun.detail || {}).map(([k, v]) => `${k}: ${v}`).join('\n') : 'Not synced yet.';
}
chrome.storage.local.get(['agent', 'email']).then(s => {
  $('agent').value = s.agent || 'http://127.0.0.1:8101';
  $('email').value = s.email || '';
  show();
});
$('save').onclick = async () => {
  await chrome.storage.local.set({ agent: $('agent').value.trim().replace(/\/$/, '') || 'http://127.0.0.1:8101', email: $('email').value.trim() });
  await chrome.storage.local.remove('token');
  $('status').textContent = 'Syncing…';
  await chrome.runtime.sendMessage({ type: 'sync' }).catch(() => {});
  show();
};
chrome.storage.onChanged.addListener(show);
