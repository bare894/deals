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
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: snapshotPage });
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

/**
 * Runs inside the product page. Returns the parts of its markup the server's extractor reads
 * (meta tags, JSON-LD, Amazon's buy box and breadcrumbs, visible MRP labels, and the price
 * fields of embedded app state) rather than the whole page, which can be several MB.
 * Must be self-contained: Chrome serializes it into the page.
 */
function snapshotPage() {
  const parts = [];
  const add = (s) => s && parts.push(s.length > 60_000 ? s.slice(0, 60_000) : s);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

  add(`<title>${esc(document.title)}</title>`);
  for (const el of document.querySelectorAll('meta, script[type="application/ld+json"]')) add(el.outerHTML);

  // Amazon.in has no JSON-LD: title, image, price box and breadcrumbs live in these elements.
  for (const sel of ['#productTitle', '#landingImage', '#corePriceDisplay_desktop_feature_div', '#corePrice_feature_div', '#apex_desktop', '#wayfinding-breadcrumbs_feature_div']) {
    add(document.querySelector(sel)?.outerHTML);
  }
  [...document.querySelectorAll('[class*="breadcrumb" i], [aria-label*="breadcrumb" i]')].slice(0, 3).forEach((el) => add(el.outerHTML));

  // Visible "MRP ₹…" labels, with enough surrounding markup to include the amount.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(), found = 0; n && found < 5; n = walker.nextNode()) {
    if (/M\.?\s?R\.?\s?P/.test(n.nodeValue)) {
      const box = n.parentElement?.parentElement || n.parentElement;
      if (box) add(box.outerHTML.slice(0, 3000)), found++;
    }
  }

  // Embedded app state (Flipkart, Myntra, AJIO, Meesho …): just the text around price keys.
  for (const s of document.querySelectorAll('script:not([src])')) {
    const t = s.textContent || '';
    let hits = 0;
    for (const m of t.matchAll(/"(?:mrp|MRP|maximumRetailPrice|listPrice|originalPrice|original_price|strikeOffPrice|wasPrice)"\s*:/g)) {
      add(t.slice(Math.max(0, m.index - 300), m.index + 300));
      if (++hits >= 5) break;
    }
  }

  return { html: parts.join('\n').slice(0, 900_000) };
}
