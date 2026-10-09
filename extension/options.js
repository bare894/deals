// Empty = automatic: www.sharedeals.in, falling back to the Railway address (see background.js).
const input = document.getElementById('base');
chrome.storage.sync.get('baseUrl').then(({ baseUrl }) => {
  input.value = baseUrl || '';
});
document.getElementById('save').addEventListener('click', async () => {
  const value = input.value.trim().replace(/\/$/, '');
  if (value) await chrome.storage.sync.set({ baseUrl: value });
  else await chrome.storage.sync.remove('baseUrl');
  await chrome.storage.session.remove('picked');
  document.getElementById('status').textContent = value ? 'Saved' : 'Saved: automatic';
});
