// Toolbar click → open ShareDeals's submit flow for the current tab in a popup window.
// The popup is a normal first-party page, so it reuses the user's web session, the
// server-side duplicate check, auto-populate, and the review-and-edit step (PRD §9.3).
// Nothing is posted until the user confirms in that window.
const DEFAULT_BASE = 'http://localhost:3000';

chrome.action.onClicked.addListener(async (tab) => {
  const { baseUrl = DEFAULT_BASE } = await chrome.storage.sync.get('baseUrl');
  const pageUrl = tab?.url || '';
  const base = baseUrl.replace(/\/$/, '');
  const target = /^https?:\/\//.test(pageUrl) && !pageUrl.startsWith(base) ? `${base}/submit?url=${encodeURIComponent(pageUrl)}` : `${base}/submit`;
  await chrome.windows.create({ url: target, type: 'popup', width: 920, height: 860 });
});
