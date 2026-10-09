const DEFAULT_BASE = 'https://sharedeals.in';
const input = document.getElementById('base');
chrome.storage.sync.get('baseUrl').then(({ baseUrl }) => {
  input.value = baseUrl || DEFAULT_BASE;
});
document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.sync.set({ baseUrl: input.value.trim().replace(/\/$/, '') || DEFAULT_BASE });
  document.getElementById('status').textContent = 'Saved';
});
