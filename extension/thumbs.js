// One-click posting from store listing pages (search results, categories, sale collections):
// a small ShareDeals button on each product thumbnail. Clicking it reads the product page in
// the background (snapshot.js, same-origin so stores don't block it), plus what the card
// itself shows as a fallback, and hands both to background.js, which posts the deal and shows
// a notification. No popup, no review step.
//
// To support another store, add an entry to STORES: `card` matches one product tile, `link`
// the product link inside it (a selector, searched through open shadow roots too, or a function
// of the card returning the product URL), `anchor` (optional) the element to put the button on,
// and `corner` (optional) moves the button off the store's own badges. A store can have several.
const STORES = [
  { host: /(^|\.)flipkart\.com$/, card: 'div[data-id]', link: 'a[href*="/p/"]' },
  { host: /(^|\.)amazon\.in$/, card: '[data-component-type="s-search-result"][data-asin]:not([data-asin=""])', link: 'a[href*="/dp/"]' },
  // Amazon's store pages (Books …) and their carousels: each product is a web component whose
  // contents live in a shadow root, which can't show a button we add inside it, so it goes on the
  // wrapper. The ASIN is on the component itself.
  {
    host: /(^|\.)amazon\.in$/,
    card: 'bds-unified-book-faceout[data-csa-c-item-id]',
    link: (card) => `https://${location.hostname}/dp/${card.dataset.csaCItemId}`,
    anchor: (card) => card.parentElement,
  },
  { host: /(^|\.)amazon\.in$/, card: 'li.a-carousel-card', link: 'a[href*="/dp/"]' },
  // Anything else (Today's Deals grid, widgets): any product image link not inside a card above.
  {
    host: /(^|\.)amazon\.in$/,
    card: 'a[href*="/dp/"]:has(img)',
    link: (card) => card.href,
    anchor: (card) => card.parentElement,
  },
  // Myntra: an "AD" badge sits top-left; lower tiles are lazy placeholders without an <img> until scrolled to.
  { host: /(^|\.)myntra\.com$/, card: 'li.product-base', link: 'a[href*="/buy"]', corner: 'right' },
];
const rules = STORES.filter((s) => s.host.test(location.hostname));

/** querySelector that also looks inside open shadow roots (Amazon's store pages are web components). */
function deepQuery(root, sel) {
  const hit = root.querySelector(sel);
  if (hit) return hit;
  for (const el of root.querySelectorAll('*')) {
    const found = el.shadowRoot && deepQuery(el.shadowRoot, sel);
    if (found) return found;
  }
  return null;
}

/** The text a card shows, including what's rendered from shadow roots (innerText skips those). */
function deepText(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return '';
  if (node.nodeType === Node.ELEMENT_NODE && /^(SCRIPT|STYLE|TEMPLATE)$/.test(node.tagName)) return '';
  const kids = [...(node.shadowRoot?.childNodes || []), ...node.childNodes];
  return kids.map(deepText).join(' ');
}

const ICON = chrome.runtime.getURL('icon32.png');
const STYLE = `
.sd-quick{position:absolute;top:6px;left:6px;z-index:5;width:30px;height:30px;padding:3px;border:0;border-radius:50%;
  background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);cursor:pointer;opacity:.9;display:grid;place-items:center}
.sd-quick.sd-right{left:auto;right:6px}
.sd-quick:hover{opacity:1;transform:scale(1.08)}
.sd-quick img{width:22px;height:22px;display:block}
.sd-quick[data-state=busy]{cursor:progress}
.sd-quick[data-state=busy] img{animation:sd-spin 1s linear infinite}
.sd-quick[data-state=done]{background:#16a34a}
.sd-quick[data-state=fail]{background:#dc2626}
.sd-quick[data-state=done] img,.sd-quick[data-state=fail] img{display:none}
.sd-quick[data-state=done]::after{content:'✓';color:#fff;font:700 16px/1 sans-serif}
.sd-quick[data-state=fail]::after{content:'!';color:#fff;font:700 16px/1 sans-serif}
@keyframes sd-spin{to{transform:rotate(360deg)}}`;

/**
 * Rupee amounts shown in the card, in order: "₹1,742 ₹2,600 33% off" → [1742, 2600],
 * Myntra's "Rs. 1121Rs. 3299(66% OFF)" → [1121, 3299]. Digit groups are matched strictly so an
 * amount running into the next text ("₹2,60033% off") doesn't swallow it.
 */
function amounts(el) {
  return [...deepText(el).matchAll(/(?:₹|Rs\.?)\s?(\d+(?:,\d{2,3})*)/g)].map((m) => Number(m[1].replace(/,/g, ''))).filter((n) => n > 0);
}

/** What the thumbnail shows: used only for fields the product page doesn't give the server. */
function cardFields(card, link) {
  const img = deepQuery(card, 'img');
  const prices = amounts(card);
  const price = prices.length ? prices[0] : null;
  const mrp = prices.slice(1).find((n) => n > price) ?? null;
  return {
    title: (link?.title || link?.getAttribute('aria-label') || card.querySelector('a[title]')?.title || img?.alt || card.querySelector('h2')?.innerText || '').trim(),
    imageUrl: img?.currentSrc || img?.src || '',
    price,
    fullPrice: mrp,
  };
}

async function post(btn, card, rule) {
  if (btn.dataset.state === 'busy') return;
  btn.dataset.state = 'busy';
  btn.title = 'Posting to ShareDeals…';
  const link = typeof rule.link === 'string' ? deepQuery(card, rule.link) : null;
  const url = link ? link.href : rule.link(card);
  let html = '';
  try {
    html = (await snapshotPage(url)).html;
  } catch {
    // The server fetches the page itself.
  }
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'sharedeals:quickPost', url, card: cardFields(card, link), html });
  } catch {
    res = { ok: false, message: 'The extension was updated — reload this page and try again.' };
  }
  btn.dataset.state = res?.ok ? 'done' : 'fail';
  btn.title = res?.message || '';
  if (!res?.ok) setTimeout(() => btn.dataset.state === 'fail' && (btn.dataset.state = ''), 6000);
}

function decorate(rule) {
  for (const card of document.querySelectorAll(rule.card)) {
    const anchor = rule.anchor ? rule.anchor(card) : card;
    if (!anchor || anchor.querySelector(':scope > .sd-quick') || card.closest('[data-sd]') || card.querySelector('[data-sd]')) continue;
    if (typeof rule.link === 'string' && !deepQuery(card, rule.link)) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = rule.corner === 'right' ? 'sd-quick sd-right' : 'sd-quick';
    btn.title = 'Post this deal to ShareDeals';
    btn.innerHTML = `<img src="${ICON}" alt="">`;
    // Capture-phase so the card's own link/click handlers never see it.
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      post(btn, card, rule);
    }, true);
    if (getComputedStyle(anchor).position === 'static') anchor.style.position = 'relative';
    anchor.prepend(btn);
    card.dataset.sd = '';
  }
}

const decorateAll = () => rules.forEach(decorate);

if (rules.length) {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.documentElement.append(style);
  decorateAll();
  // Listings load more results as you scroll or filter without a page load.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      decorateAll();
    }, 300);
  }).observe(document.body, { childList: true, subtree: true });
}
