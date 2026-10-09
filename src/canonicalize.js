// URL canonicalization for duplicate detection (PRD §10.1).
import { createHash } from 'node:crypto';

// Query params that never identify the product: tracking, affiliate, and click ids.
const TRACKING_PARAMS = new Set([
  'ref', 'ref_', 'referrer', 'tag', 'aff_id', 'affid', 'aff', 'affiliate', 'affiliate_id',
  'gclid', 'gclsrc', 'dclid', 'fbclid', 'msclkid', 'yclid', 'twclid', 'ttclid', 'li_fat_id',
  'mc_cid', 'mc_eid', '_ga', '_gl', 'igshid', 'srsltid', 'cmpid', 'cid', 'clickid', 'irclickid',
  'irgwc', 'sharedid', 'subid', 'sub_id', 'psc', 'th', 'linkcode', 'linkid', 'camp', 'creative',
  'creativeasin', 'ascsubtag', 'pd_rd_i', 'pd_rd_r', 'pd_rd_w', 'pd_rd_wg', 'pf_rd_p', 'pf_rd_r',
  'qid', 'sr', 'sprefix', 'crid', 'smid', 'spm', 'scm', 'wmlspartner',
  'veh', 'adid', 'athcpid', 'athpgid', 'athznid', 'athieid', 'athstid', 'athguid', 'athancid',
  'athena', 'intcmp', 'icid', 'ranmid', 'raneaid', 'ransiteid',
]);
// Deliberately conservative: a param we strip wrongly can block a legitimately different
// product as a "duplicate", which is worse than letting a rare duplicate through.
const TRACKING_PREFIXES = ['utm_', 'pd_rd_', 'pf_rd_', 'mkt_', 'hsa_', 'oly_'];

export const URL_SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'amzn.to', 'a.co', 'goo.gl', 'ow.ly', 'buff.ly', 'rebrand.ly',
  'shorturl.at', 'cutt.ly', 'is.gd', 'tiny.cc', 'bl.ink', 'linktr.ee',
  'fkrt.it', 'fkrt.co', 'amzn.in', 'myntr.it',
]);

// Indian marketplaces: reduce product URLs to the id that identifies the product, so the same
// item shared from the app, search results, or an affiliate link canonicalizes identically.
function retailerCanonical(host, url) {
  const p = url.pathname;
  const m = (re) => p.match(re)?.[1];
  if (host === 'flipkart.com' || host === 'dl.flipkart.com') {
    const itm = m(/\/p\/(itm[a-z0-9]+)/i);
    if (itm) {
      const pid = url.searchParams.get('pid'); // pid identifies the variant (colour / storage)
      return `https://flipkart.com/p/${itm.toLowerCase()}${pid ? `?pid=${pid.toUpperCase()}` : ''}`;
    }
  }
  if (host === 'myntra.com') {
    const id = m(/\/(\d{5,})(?:\/buy)?\/?$/);
    if (id) return `https://myntra.com/${id}`;
  }
  if (host === 'nykaa.com' || host === 'nykaafashion.com') {
    const id = m(/\/p\/(\d+)/);
    if (id) {
      const sku = url.searchParams.get('skuId'); // shade / size variant
      return `https://${host}/p/${id}${sku ? `?skuId=${sku}` : ''}`;
    }
  }
  if (host === 'ajio.com' || host === 'meesho.com') {
    const id = m(/\/p\/([a-z0-9_]+)/i);
    if (id) return `https://${host}/p/${id.toLowerCase()}`;
  }
  return null;
}

function isTracking(key) {
  const k = key.toLowerCase();
  return TRACKING_PARAMS.has(k) || TRACKING_PREFIXES.some((p) => k.startsWith(p));
}

/** Parse and validate a user-supplied deal URL. Throws on anything that isn't http(s). */
export function parseDealUrl(input) {
  let raw = String(input ?? '').trim();
  if (!raw) throw new Error('URL is required');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("That doesn't look like a valid URL");
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) links are supported');
  if (!url.hostname.includes('.')) throw new Error("That doesn't look like a valid URL");
  return url;
}

/** Canonical form of a URL: same product page => same string, regardless of tracking noise. */
export function canonicalizeUrl(input) {
  const url = input instanceof URL ? new URL(input.href) : parseDealUrl(input);
  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '').replace(/^smile\./, '');

  // Amazon product URLs come in many shapes (/Some-Slug/dp/ASIN/ref=..., /gp/product/ASIN);
  // the ASIN alone identifies the product.
  if (/(^|\.)amazon\.[a-z.]+$/.test(host)) {
    const asin = url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/asin)\/([A-Z0-9]{10})/i);
    if (asin) return `https://${host}/dp/${asin[1].toUpperCase()}`;
  }
  const retailer = retailerCanonical(host, url);
  if (retailer) return retailer;

  let path = url.pathname.replace(/\/{2,}/g, '/');
  path = path.replace(/\/ref=[^/]*$/i, ''); // Amazon-style trailing /ref=xyz
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path === '/') path = '';

  const params = [...url.searchParams.entries()]
    .filter(([k]) => !isTracking(k))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';

  // Scheme is normalized to https: http/https variants of the same page are the same deal.
  return `https://${host}${path}${query}`;
}

/** "www.shop.co.in" → "shop.co.in", "dl.flipkart.com" → "flipkart.com". Identifies a store. */
export function registrableDomain(hostname) {
  const labels = String(hostname).toLowerCase().replace(/^\[|\]$/g, '').split('.');
  // Second-level country domains like shop.co.in need three labels, not two.
  const n = labels.length >= 3 && /^(co|net|org|gov|ac|firm|gen|ind)$/.test(labels.at(-2)) ? 3 : 2;
  return labels.slice(-n).join('.');
}

export function hashUrl(canonical) {
  return createHash('sha256').update(canonical).digest('hex');
}

export function isShortener(url) {
  const host = (url instanceof URL ? url : new URL(url)).hostname.toLowerCase().replace(/^www\./, '');
  return URL_SHORTENERS.has(host);
}
