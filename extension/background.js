// Toolbar click → open ShareDeals's "Post a deal" page for the current tab in a popup window.
// The popup is the website itself, so it uses the user's normal ShareDeals sign-in (showing the
// sign-in page first if needed), runs the duplicate check and the review-and-edit step, and
// nothing is posted until the user confirms (PRD §9.3).
//
// Auto-fill: stores often block requests from servers, so the extension also copies the product
// details from the page as the user sees it and hands them to the popup. The server reads that
// copy with the same extractor it uses for fetched pages, and only fetches to fill gaps.
// Sites tried in order when no site is set on the Options page: the first one whose /api/health
// answers ok is used. www.sharedeals.in is the real address; the Railway one keeps the extension
// working while the custom domain is down. (The bare sharedeals.in isn't listed: it goes through
// GoDaddy forwarding, which only redirects the home page, so /submit there is a 404.)
const SITES = ['https://www.sharedeals.in', 'https://deals-production-1ecf.up.railway.app'];
const POPUP = { type: 'popup', width: 920, height: 860 };

async function isUp(base) {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(4000), cache: 'no-store' });
    return res.ok && (await res.json()).ok === true;
  } catch {
    return false;
  }
}

/** The site to post to: the one set on the Options page, else the first healthy one (remembered for 10 minutes). */
async function siteBase() {
  const { baseUrl } = await chrome.storage.sync.get('baseUrl');
  const saved = (baseUrl || '').replace(/\/$/, '');
  // A saved sharedeals.in address (from older versions) means "the real site": use the automatic choice.
  if (saved && !/^https?:\/\/(www\.)?sharedeals\.in$/i.test(saved)) return saved;
  const { picked } = await chrome.storage.session.get('picked');
  if (picked && Date.now() - picked.at < 10 * 60_000) return picked.base;
  for (const base of SITES) {
    if (await isUp(base)) {
      await chrome.storage.session.set({ picked: { base, at: Date.now() } });
      return base;
    }
  }
  return SITES[SITES.length - 1]; // all down: open the last one so the user at least sees what's wrong
}

chrome.action.onClicked.addListener(async (tab) => {
  const base = await siteBase();
  const pageUrl = tab?.url || '';
  if (!/^https?:\/\//.test(pageUrl) || pageUrl.startsWith(base)) {
    await chrome.windows.create({ ...POPUP, url: `${base}/submit` });
    return;
  }

  let snapshot = null;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['snapshot.js'] });
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => snapshotPage() });
    snapshot = res?.result || null;
  } catch {
    // Pages Chrome won't let extensions read (Web Store, PDFs …): the server fetches it instead.
  }

  const url = `${base}/submit?url=${encodeURIComponent(pageUrl)}${snapshot ? '&via=extension' : ''}`;
  const win = await chrome.windows.create({ ...POPUP, url });
  if (snapshot && win.tabs?.[0]) handOver(win.tabs[0].id, { ...snapshot, url: pageUrl });
});

/** Once the popup has loaded, post the snapshot into it (the page listens for this message). */
function handOver(tabId, snapshot) {
  const onUpdated = async (id, info) => {
    if (id !== tabId || info.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (data) => window.postMessage({ type: 'sharedeals:snapshot', ...data }, location.origin),
        args: [snapshot],
      });
    } catch (err) {
      // The site URL isn't in host_permissions (see manifest.json): the server fetches the page instead.
      console.warn('ShareDeals: could not hand the page details to the popup:', err.message);
    }
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  setTimeout(() => chrome.tabs.onUpdated.removeListener(onUpdated), 60_000);
}

// ------------------------------------------------------------ one-click posting (thumbs.js)

const STORE_NAMES = { 'amazon.in': 'Amazon', 'flipkart.com': 'Flipkart', 'myntra.com': 'Myntra' };

async function api(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    credentials: 'include',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

function notify(title, message, link) {
  const id = `sd-${Date.now()}`;
  chrome.notifications.create(id, { type: 'basic', iconUrl: 'icon128.png', title, message });
  if (link) notifyLinks.set(id, link);
}
const notifyLinks = new Map();
chrome.notifications.onClicked.addListener((id) => {
  const link = notifyLinks.get(id);
  if (link) chrome.tabs.create({ url: link });
  chrome.notifications.clear(id);
});

/**
 * Posts the deal straight away, with what the server reads from the product page and the
 * thumbnail filling any gaps. Same product already on ShareDeals: the link is added to that deal.
 */
async function quickPost({ url, card, html }) {
  const base = await siteBase();
  let pre;
  try {
    pre = await api(base, '/api/deals/prefill', { url, html });
  } catch (err) {
    if (err.status === 401) {
      chrome.tabs.create({ url: `${base}/login` });
      return { ok: false, message: 'Sign in to ShareDeals, then try again.' };
    }
    if (err.data?.duplicate) return { ok: false, message: `Already posted: ${err.data.duplicate.title}` };
    throw err;
  }
  const f = pre.fields || {};
  const host = new URL(pre.url || url).hostname.replace(/^www\./, '');
  const body = {
    url: pre.url || url,
    title: f.title || card.title,
    imageUrl: f.imageUrl || card.imageUrl,
    price: f.price ?? card.price,
    fullPrice: f.fullPrice ?? card.fullPrice,
    store: f.store || STORE_NAMES[host] || host,
    categoryId: f.categoryId,
    gtin: f.gtin,
    mpn: f.mpn,
  };
  if (body.fullPrice != null && body.price != null && body.fullPrice < body.price) body.fullPrice = null;
  if (!body.categoryId) {
    const { categories = [] } = await api(base, '/api/meta');
    body.categoryId = (categories.find((c) => c.name === 'Other') || categories[categories.length - 1])?.id;
  }

  const attach = async (deal) => {
    await api(base, `/api/deals/${deal.id}/offers`, body);
    return { ok: true, message: `Added your ${body.store} link to “${deal.title}”`, link: `${base}/deals/${deal.id}` };
  };
  const high = (pre.matches || []).find((m) => m.confidence === 'high' && !m.storeListed);
  if (high) return attach(high.deal);
  try {
    const { deal } = await api(base, '/api/deals', { ...body, confirmNew: false });
    return { ok: true, message: `Posted “${deal.title}”`, link: `${base}/deals/${deal.id}` };
  } catch (err) {
    const match = err.data?.matches?.find((m) => !m.storeListed);
    if (match) return attach(match.deal);
    throw err;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'sharedeals:quickPost') return;
  quickPost(msg)
    .catch((err) => ({ ok: false, message: err.message || 'Could not post this deal' }))
    .then((res) => {
      notify(res.ok ? 'Deal posted' : 'Not posted', res.message, res.link);
      reply(res);
    });
  return true; // reply is async
});
