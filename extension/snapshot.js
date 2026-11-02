/**
 * Runs inside the product page. Returns the parts of its markup the server's extractor reads
 * (meta tags, JSON-LD, Amazon's buy box and breadcrumbs, visible MRP labels, and the price
 * fields of embedded app state) rather than the whole page, which can be several MB.
 *
 * Single-page stores (Flipkart) don't update <title>, meta tags or JSON-LD when you click
 * through to a product, so the live page can still describe the home or search page. So we
 * first re-fetch the current URL from the page itself (the user's browser, cookies and IP,
 * which stores don't block) and read that fresh copy; the live page's parts come after it.
 * The extractor takes the first title/meta/product it finds, so the fresh copy wins.
 *
 * Shared by the toolbar button (injected into the page by background.js) and the thumbnail
 * buttons on store listing pages (thumbs.js), which pass the product's URL: same-origin, so the
 * fetch works there too, and the listing page itself is skipped as it isn't that product.
 */
async function snapshotPage(href = location.href) {
  const parts = [];
  const add = (s) => s && parts.push(s.length > 60_000 ? s.slice(0, 60_000) : s);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

  const collect = (doc) => {
    add(`<title>${esc(doc.title)}</title>`);
    for (const el of doc.querySelectorAll('meta, script[type="application/ld+json"]')) add(el.outerHTML);

    // Amazon.in has no JSON-LD: title, image, price box, breadcrumbs and a book's format/ISBN live in these elements.
    for (const sel of ['#productTitle', '#landingImage', '#corePriceDisplay_desktop_feature_div', '#corePrice_feature_div', '#apex_desktop', '#wayfinding-breadcrumbs_feature_div', '#productSubtitle', '#detailBullets_feature_div']) {
      add(doc.querySelector(sel)?.outerHTML);
    }
    [...doc.querySelectorAll('[class*="breadcrumb" i], [aria-label*="breadcrumb" i]')].slice(0, 3).forEach((el) => add(el.outerHTML));

    // Visible "MRP ₹…" labels, with enough surrounding markup to include the amount.
    if (doc.body) {
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(), found = 0; n && found < 5; n = walker.nextNode()) {
        if (/M\.?\s?R\.?\s?P/.test(n.nodeValue)) {
          const box = n.parentElement?.parentElement || n.parentElement;
          if (box) add(box.outerHTML.slice(0, 3000)), found++;
        }
      }
    }

    // Embedded app state (Flipkart, Myntra, AJIO, Meesho …): just the text around price keys.
    for (const s of doc.querySelectorAll('script:not([src])')) {
      const t = s.textContent || '';
      let hits = 0;
      for (const m of t.matchAll(/"(?:mrp|MRP|maximumRetailPrice|listPrice|originalPrice|original_price|strikeOffPrice|wasPrice)"\s*:/g)) {
        add(t.slice(Math.max(0, m.index - 300), m.index + 300));
        if (++hits >= 5) break;
      }
    }
  };

  try {
    const res = await fetch(href, { credentials: 'include', signal: AbortSignal.timeout(8000) });
    if (res.ok && /html/i.test(res.headers.get('content-type') || '')) {
      collect(new DOMParser().parseFromString(await res.text(), 'text/html'));
    }
  } catch {
    // Offline, slow or refused: the live page below is all we have.
  }
  if (href === location.href) collect(document);

  return { html: parts.join('\n').slice(0, 900_000) };
}
