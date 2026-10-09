// Server-side auto-populate (PRD §9 step 3): fetch a product page and extract
// title / image / price / store from Open Graph + schema.org Product JSON-LD.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import { isShortener, parseDealUrl, registrableDomain } from './canonicalize.js';

const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 ShareDealsBot/1.0 (+https://sharedeals.in)';

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
        'accept-language': 'en-IN,en;q=0.9,hi;q=0.6',
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
  // Commas are only ever digit grouping here — including Indian lakh grouping (₹1,29,999).
  const m = String(v).replace(/[,\s]/g, '').match(/\d+(?:\.\d{1,2})?/);
  return m ? Number(m[0]) : null;
}

function first(v) {
  return Array.isArray(v) ? v[0] : v;
}

// Indian retailers (the site is India-focused). Unknown hosts fall back to a capitalized domain name.
const KNOWN_STORES = {
  'flipkart.com': 'Flipkart', 'myntra.com': 'Myntra', 'amazon.in': 'Amazon', 'amazon.com': 'Amazon',
  'ajio.com': 'AJIO', 'nykaa.com': 'Nykaa', 'nykaafashion.com': 'Nykaa Fashion', 'meesho.com': 'Meesho',
  'tatacliq.com': 'Tata CLiQ', 'croma.com': 'Croma', 'reliancedigital.in': 'Reliance Digital', 'jiomart.com': 'JioMart',
  'bigbasket.com': 'BigBasket', 'snapdeal.com': 'Snapdeal', 'firstcry.com': 'FirstCry', 'lenskart.com': 'Lenskart',
  'decathlon.in': 'Decathlon', 'vijaysales.com': 'Vijay Sales', 'purplle.com': 'Purplle', 'shoppersstop.com': 'Shoppers Stop',
  'pepperfry.com': 'Pepperfry', 'urbanladder.com': 'Urban Ladder', 'boat-lifestyle.com': 'boAt', 'apple.com': 'Apple',
};

export function storeFromHost(hostname) {
  const base = registrableDomain(hostname);
  if (KNOWN_STORES[base]) return KNOWN_STORES[base];
  const name = base.split('.')[0] || hostname;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// ------------------------------------------------------------ retailer fallbacks
// Indian retailers rarely publish MRP or category as structured data, and Amazon.in has no
// JSON-LD at all, so these read the visible labels and the page's embedded app state.

const amount = (s) => parsePrice(String(s).replace(/,/g, ''));

// In order of trust: the visible "M.R.P." label, Amazon's struck-through price, embedded JSON keys.
const MRP_PATTERNS = [
  /\bM\.?R\.?P\.?(?:[^₹<\d]|<[^<>]{0,200}>){0,160}?(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)/g,
  /data-a-strike="true"[^>]*>\s*<span class="a-offscreen">\s*₹\s*([\d,]+(?:\.\d{1,2})?)/g,
  /"(?:mrp|MRP|maximumRetailPrice|maxRetailPrice|listPrice|list_price|originalPrice|original_price|strikeOffPrice|strikethroughPrice|wasPrice)"\s*:\s*(?:\{[^{}]{0,80}?"(?:value|amount|decimalValue)"\s*:\s*)?"?([\d,]+(?:\.\d{1,2})?)/g,
];

/** First plausible MRP: above the selling price, and not more than 20× it (so not another product's price). */
export function findMrp(html, price) {
  for (const re of MRP_PATTERNS) {
    for (const m of html.matchAll(re)) {
      const v = amount(m[1]);
      if (v == null || v <= 0) continue;
      if (price == null || (v > price && v <= price * 20)) return v;
    }
  }
  return null;
}

function amazonFields(html) {
  const priceToPay = html.match(/priceToPay[\s\S]{0,600}?class="a-price-whole">([\d,]+)/) || html.match(/id="corePrice[\s\S]{0,1500}?class="a-price-whole">([\d,]+)/);
  const title = html.match(/id="productTitle"[^>]*>([^<]+)</);
  const img = html.match(/<img[^>]*id="landingImage"[^>]*>/);
  const crumbs = html.match(/id="wayfinding-breadcrumbs_feature_div"([\s\S]{0,6000}?)<\/ul>/);
  return {
    price: priceToPay ? amount(priceToPay[1]) : null,
    title: title ? decodeEntities(title[1]).trim() : null,
    image: img ? attr(img[0], 'data-old-hires') || attr(img[0], 'src') : null,
    breadcrumbs: crumbs ? [...crumbs[1].matchAll(/<a[^>]*>([^<]+)<\/a>/g)].map((m) => decodeEntities(m[1]).trim()) : [],
  };
}

function jsonLdBreadcrumbs(html) {
  for (const [, json] of html.matchAll(/<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      for (const node of walkJsonLd(JSON.parse(json.trim()))) {
        if (hasType(node, 'BreadcrumbList')) {
          return [].concat(node.itemListElement || []).map((e) => e?.name || e?.item?.name).filter(Boolean).map(String);
        }
      }
    } catch {
      /* ignore */
    }
  }
  return [];
}

// Site categories (see DEFAULT_CATEGORIES in db.js). Checked in order, so specific beats generic
// ("Smart Watches" → Electronics before "Watches" → Fashion).
const CATEGORY_RULES = [
  ['Mobiles', /\b(mobiles?|smart ?phones?|mobile phones?|handsets?|basic mobiles?)\b/i],
  ['Electronics', /\bsmart ?(watch|watches|band)\b/i],
  ['Gaming', /\b(video games?|gaming|play ?station|ps[45]|xbox|nintendo|consoles?)\b/i],
  ['Beauty & Personal Care', /\b(beauty|make-?up|skin ?care|hair ?care|fragrances?|perfumes?|personal care|grooming|cosmetics|sunscreens?|foundations?|shampoos?)\b/i],
  ['Grocery', /\b(grocery|groceries|gourmet|foods?|beverages?|snacks|staples|dals?|pulses|atta|rice)\b/i],
  ['Toys & Kids', /\b(toys?|baby|kids|children|infants?)\b/i],
  ['Travel', /\b(luggage|suitcases?|travel|trolley bags?|duffel)\b/i],
  ['Fashion', /\b(fashion|clothing|apparel|footwear|shoes|sneakers|sandals|kurtas?|kurtis?|sarees?|jeans|t-?shirts?|shirts?|dresses|watches|jewell?ery|handbags|eyewear|sunglasses|ethnic wear|innerwear)\b/i],
  ['Home & Kitchen', /\b(home|kitchen|furniture|appliances?|bed ?sheets?|bedding|d[eé]cor|furnishings?|cookware|mixer|grinder|washing machines?|refrigerators?|air conditioners?|vacuum)\b/i],
  ['Electronics', /\b(electronics|headphones?|earphones?|earbuds|speakers?|laptops?|computers?|televisions?|tvs?|cameras?|tablets?|wearables?|monitors?|kindle|e-?readers?|chargers?|power ?banks?)\b/i],
  ['Apps & Services', /\b(apps?|software|subscriptions?|gift cards?|recharge)\b/i],
];

/** Map breadcrumb/category labels (most specific last) and the title onto a site category name. */
export function guessCategory(labels, title = '') {
  for (const label of [...labels].reverse()) {
    for (const [name, re] of CATEGORY_RULES) if (re.test(label)) return name;
  }
  for (const [name, re] of CATEGORY_RULES) if (re.test(title)) return name;
  return null;
}

export function extractDealFields(html, pageUrl) {
  const meta = metaTags(html);
  const product = findProduct(html);
  const url = new URL(pageUrl);

  const amazon = /(^|\.)amazon\.(in|com)$/.test(url.hostname) ? amazonFields(html) : null;

  let title = product?.name || meta['og:title'] || meta['twitter:title'] || amazon?.title;
  if (!title) {
    const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (t) title = decodeEntities(t[1]).replace(/\s+/g, ' ').trim();
  }

  let image = first(product?.image);
  if (image && typeof image === 'object') image = image.url || image.contentUrl;
  image = image || meta['og:image'] || meta['og:image:url'] || meta['og:image:secure_url'] || meta['twitter:image'] || amazon?.image;
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
  price ??= parsePrice(meta['product:price:amount'] ?? meta['og:price:amount'] ?? meta['product:sale_price:amount'] ?? meta.price) ?? amazon?.price ?? null;
  fullPrice ??= parsePrice(meta['product:original_price:amount'] ?? meta['product:retail_price:amount']);
  if (fullPrice != null && price != null && fullPrice <= price) fullPrice = null;
  fullPrice ??= findMrp(html, price);

  const productCategory = [].concat(product?.category ?? []).map((c) => (typeof c === 'object' ? c?.name : c)).filter(Boolean).map(String);
  const category = guessCategory(
    [...jsonLdBreadcrumbs(html), ...(amazon?.breadcrumbs || []), ...productCategory, meta['product:category'] || ''].filter(Boolean),
    title || '',
  );

  const store = meta['og:site_name'] || storeFromHost(url.hostname);

  // Product identifiers let us recognise the same product across different stores.
  const gtinRaw = product && (product.gtin13 || product.gtin12 || product.gtin14 || product.gtin8 || product.gtin || offers?.gtin13 || offers?.gtin);
  const gtin = gtinRaw && /^\d{8,14}$/.test(String(gtinRaw).trim()) ? String(gtinRaw).trim().padStart(14, '0') : null;
  const mpn = product?.mpn ? String(product.mpn).trim().slice(0, 64) : null;

  return {
    title: title ? String(title).replace(/\s+/g, ' ').trim().slice(0, 200) : '',
    imageUrl: image || '',
    price,
    fullPrice,
    store: String(store).slice(0, 80),
    category,
    gtin,
    mpn,
  };
}

/** Fetch + extract. Never throws for scrape failures — returns { ok:false, reason } instead (PRD §9.1). */
export async function autoPopulate(rawUrl, fetcher = safeFetch) {
  const url = parseDealUrl(rawUrl);
  const fallback = { title: '', imageUrl: '', price: null, fullPrice: null, store: storeFromHost(url.hostname), category: null, gtin: null, mpn: null };
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
