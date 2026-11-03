// IndexNow (https://www.indexnow.org): tells Bing, Yandex and other participating search engines
// about new, changed and removed deal pages straight away, rather than waiting for a crawl.
// Google doesn't take part; it reads sitemap.xml. The key isn't secret: engines verify it by
// fetching /<key>.txt from the site.
import { dealPath } from './seo.js';

export const INDEXNOW_KEY = process.env.INDEXNOW_KEY || '5f0c2a9e7d4b4c1e8a3f6b2d9e1c7a40';
const ENDPOINT = 'https://api.indexnow.org/indexnow';
const BATCH_MS = 10_000;

// Deal-changing API calls → the deal ids they touch.
const DEAL_ROUTES = [
  [/^POST \/api\/deals$/, (m, result) => [result?.deal?.id]],
  [/^PATCH \/api\/deals\/(\d+)$/, (m) => [m[1]]],
  [/^POST \/api\/deals\/(\d+)\/offers$/, (m) => [m[1]]],
  [/^POST \/api\/admin\/deals\/(\d+)\/(remove|restore)$/, (m) => [m[1]]],
  [/^POST \/api\/admin\/deals\/(\d+)\/merge$/, (m, result, body) => [m[1], String(body.intoId ?? '').replace(/^#/, '')]],
];
const OFFER_ROUTE = /^(PATCH|DELETE) \/api\/offers\/(\d+)$|^POST \/api\/admin\/offers\/(\d+)\/(remove|restore)$/;

export function createIndexNow({ db, baseUrl, enabled, fetchImpl = fetch }) {
  const pending = new Set();
  let timer = null;

  async function flush() {
    timer = null;
    const ids = [...pending].map(Number).filter((n) => Number.isInteger(n) && n > 0);
    pending.clear();
    if (!ids.length) return;
    const rows = await db.all(`SELECT id, title FROM deals WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
    const urlList = rows.map((d) => `${baseUrl}${dealPath(d)}`);
    if (!urlList.length) return;
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: new URL(baseUrl).host, key: INDEXNOW_KEY, keyLocation: `${baseUrl}/${INDEXNOW_KEY}.txt`, urlList }),
    });
    if (!res.ok && res.status !== 202) console.warn(`[indexnow] ${res.status} for ${urlList.length} url(s)`);
  }

  /** Called after every successful API call; queues the deals it changed. Never throws. */
  async function afterApi(method, pathname, body, result) {
    if (!enabled) return;
    try {
      const key = `${method} ${pathname}`;
      for (const [re, ids] of DEAL_ROUTES) {
        const m = key.match(re);
        if (m) ids(m, result, body).forEach((id) => pending.add(id));
      }
      const o = key.match(OFFER_ROUTE);
      if (o) {
        const deal = await db.get('SELECT deal_id FROM offers WHERE id = ?', Number(o[2] || o[3]));
        if (deal) pending.add(deal.deal_id);
      }
      if (pending.size && !timer) timer = setTimeout(() => flush().catch((err) => console.warn('[indexnow]', err.message)), BATCH_MS);
    } catch (err) {
      console.warn('[indexnow]', err.message);
    }
  }

  return { afterApi };
}
