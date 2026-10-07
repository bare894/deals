// Server-side auto-populate (PRD §9 step 3): fetch a product page and extract
// title / image / price / store from Open Graph + schema.org Product JSON-LD.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import { isShortener, parseDealUrl } from './canonicalize.js';

const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 DealShareBot/1.0';

// ---------- SSRF guard: never let a pasted URL reach internal addresses ----------

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
].map(([base, bits]) => [ipv4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKS.some(([base, mask]) => ((n & mask) >>> 0) === base);
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
  }
  return true;
}

const allowPrivate = () => process.env.ALLOW_PRIVATE_FETCH === '1';

// Used as the socket's DNS lookup, so the IP we validate is the IP we connect to (no TOCTOU).
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!allowPrivate() && addresses.some((a) => isPrivateIp(a.address))) {
      return callback(Object.assign(new Error(`Blocked address for ${hostname}`), { code: 'EBLOCKED' }));
    }
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

function requestOnce(url, { maxBytes }) {
  return new Promise((resolve, reject) => {
    if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && !allowPrivate() && isPrivateIp(url.hostname.replace(/^\[|\]$/g, ''))) {
      return reject(Object.assign(new Error('Blocked address'), { code: 'EBLOCKED' }));
    }
    if (url.port && !['80', '443'].includes(url.port) && !allowPrivate()) {
      return reject(Object.assign(new Error('Only standard ports are allowed'), { code: 'EBLOCKED' }));
    }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: 'GET',
      lookup: guardedLookup,
      timeout: TIMEOUT_MS,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
      },
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.on('response', (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        return resolve({ redirect: new URL(headers.location, url) });
      }
      const enc = String(headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      let size = 0;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve({ status: statusCode, headers, body: Buffer.concat(chunks).toString('utf8') });
      };
      stream.on('data', (c) => {
        chunks.push(c);
        size += c.length;
        if (size > maxBytes) {
          // Enough to find <head> metadata; stop reading.
          finish();
          req.destroy();
        }
      });
      stream.on('error', (err) => (done ? undefined : reject(err)));
      stream.on('end', finish);
    });
    req.end();
  });
}

export async function safeFetch(input, { maxBytes = MAX_BYTES } = {}) {
  let url = input instanceof URL ? input : new URL(input);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Unsupported redirect');
    const res = await requestOnce(url, { maxBytes });
    if (res.redirect) {
      url = res.redirect;
      continue;
    }
    return { ...res, finalUrl: url };
  }
  throw new Error('Too many redirects');
}

/** Follow a URL shortener (bit.ly, amzn.to, …) to its destination. Returns the input on failure. */
export async function resolveShortener(url) {
  if (!isShortener(url)) return url;
  try {
    const { finalUrl } = await safeFetch(url, { maxBytes: 64_000 });
    return finalUrl;
  } catch {
    return url;
  }
}

// ---------- HTML metadata extraction ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+|#39);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'));
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

function metaTags(html) {
  const out = {};
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = attr(tag, 'property') || attr(tag, 'name') || attr(tag, 'itemprop');
    const content = attr(tag, 'content');
    if (key && content != null) {
      const k = key.toLowerCase();
      if (!(k in out)) out[k] = decodeEntities(content).trim();
    }
  }
  return out;
}

function* walkJsonLd(node) {
  if (Array.isArray(node)) for (const n of node) yield* walkJsonLd(n);
  else if (node && typeof node === 'object') {
    yield node;
    if (node['@graph']) yield* walkJsonLd(node['@graph']);
  }
}

function hasType(node, type) {
  const t = node['@type'];
  return Array.isArray(t) ? t.includes(type) : t === type;
}

function findProduct(html) {
  for (const [, json] of html.matchAll(/<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      for (const node of walkJsonLd(JSON.parse(json.trim()))) {
        if (hasType(node, 'Product') || hasType(node, 'ProductGroup')) return node;
      }
    } catch {
      /* malformed JSON-LD is common; ignore */
    }
  }
  return null;
}

export function parsePrice(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null;
  const m = String(v).replace(/[\s,](?=\d{3}\b)/g, '').match(/\d+(?:\.\d{1,2})?/);
  return m ? Number(m[0]) : null;
}

function first(v) {
  return Array.isArray(v) ? v[0] : v;
}

const KNOWN_STORES = {
  'amazon.com': 'Amazon', 'bestbuy.com': 'Best Buy', 'walmart.com': 'Walmart', 'target.com': 'Target',
  'costco.com': 'Costco', 'newegg.com': 'Newegg', 'homedepot.com': 'The Home Depot', 'lowes.com': "Lowe's",
  'ebay.com': 'eBay', 'macys.com': "Macy's", 'nordstrom.com': 'Nordstrom', 'kohls.com': "Kohl's",
  'bhphotovideo.com': 'B&H Photo', 'samsclub.com': "Sam's Club", 'apple.com': 'Apple', 'nike.com': 'Nike',
  'steampowered.com': 'Steam', 'wayfair.com': 'Wayfair', 'adorama.com': 'Adorama', 'gamestop.com': 'GameStop',
};

export function storeFromHost(hostname) {
  const host = hostname.toLowerCase().replace(/^(www|m|smile|store|shop)\./, '');
  const base = host.split('.').slice(-2).join('.');
  if (KNOWN_STORES[base]) return KNOWN_STORES[base];
  const name = host.split('.').slice(-2, -1)[0] || host;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function extractDealFields(html, pageUrl) {
  const meta = metaTags(html);
  const product = findProduct(html);
  const url = new URL(pageUrl);

  let title = product?.name || meta['og:title'] || meta['twitter:title'];
  if (!title) {
    const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (t) title = decodeEntities(t[1]).replace(/\s+/g, ' ').trim();
  }

  let image = first(product?.image);
  if (image && typeof image === 'object') image = image.url || image.contentUrl;
  image = image || meta['og:image'] || meta['og:image:url'] || meta['og:image:secure_url'] || meta['twitter:image'];
  if (image) {
    try {
      image = new URL(decodeEntities(image), url).href;
      if (!/^https?:/.test(image)) image = null;
    } catch {
      image = null;
    }
  }

  let price = null;
  let fullPrice = null;
  const offers = first(product?.offers);
  if (offers) {
    price = parsePrice(offers.price ?? offers.lowPrice ?? first(offers.priceSpecification)?.price);
    for (const spec of [].concat(offers.priceSpecification || [])) {
      if (/ListPrice|StrikethroughPrice|MSRP/i.test(String(spec?.priceType || ''))) fullPrice = parsePrice(spec.price);
    }
    if (offers.highPrice && offers.lowPrice && fullPrice == null) {
      const hp = parsePrice(offers.highPrice);
      if (hp > price) fullPrice = hp;
    }
  }
  price ??= parsePrice(meta['product:price:amount'] ?? meta['og:price:amount'] ?? meta['product:sale_price:amount'] ?? meta.price);
  fullPrice ??= parsePrice(meta['product:original_price:amount'] ?? meta['product:retail_price:amount']);
  if (fullPrice != null && price != null && fullPrice <= price) fullPrice = null;

  const store = meta['og:site_name'] || storeFromHost(url.hostname);

  return {
    title: title ? String(title).replace(/\s+/g, ' ').trim().slice(0, 200) : '',
    imageUrl: image || '',
    price,
    fullPrice,
    store: String(store).slice(0, 80),
  };
}

/** Fetch + extract. Never throws for scrape failures — returns { ok:false, reason } instead (PRD §9.1). */
export async function autoPopulate(rawUrl, fetcher = safeFetch) {
  const url = parseDealUrl(rawUrl);
  const fallback = { title: '', imageUrl: '', price: null, fullPrice: null, store: storeFromHost(url.hostname) };
  try {
    const res = await fetcher(url);
    const ct = String(res.headers?.['content-type'] || '');
    if (res.status >= 400) return { ok: false, reason: `Retailer responded with HTTP ${res.status}`, fields: fallback, finalUrl: res.finalUrl?.href };
    if (ct && !/html|xml/i.test(ct)) return { ok: false, reason: 'Link is not a web page', fields: fallback, finalUrl: res.finalUrl?.href };
    const fields = extractDealFields(res.body, res.finalUrl || url);
    const ok = Boolean(fields.title || fields.imageUrl || fields.price != null);
    return { ok, reason: ok ? null : 'No product details found on the page', fields: { ...fallback, ...fields }, finalUrl: res.finalUrl?.href };
  } catch (err) {
    const reason = err.code === 'EBLOCKED' ? 'That address is not allowed' : err.code === 'ETIMEDOUT' ? 'The retailer took too long to respond' : 'Could not reach the page';
    return { ok: false, reason, fields: fallback };
  }
}
