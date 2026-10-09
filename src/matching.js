// Cross-store product matching: is the Flipkart link someone is posting the same product as an
// existing deal that already has an Amazon link?
//
// Strongest signals first: GTIN/EAN barcode, then manufacturer part number (both from the
// retailer's schema.org data when present), then title analysis. Title matching is built to
// avoid the expensive mistake — merging different products — so any conflict in variant words
// (Pro/Max/FE…), specs (128GB vs 256GB) or model numbers (XM5 vs XM6) is an automatic non-match.

const COLORS = new Set([
  'black', 'white', 'blue', 'red', 'green', 'grey', 'gray', 'silver', 'gold', 'pink', 'purple', 'yellow', 'orange',
  'brown', 'beige', 'navy', 'maroon', 'teal', 'olive', 'cream', 'midnight', 'starlight', 'graphite', 'titanium',
  'natural', 'rose', 'violet', 'lavender', 'mint', 'charcoal', 'multicolor', 'multicolour', 'multi',
]);
const NOISE = new Set([
  'the', 'with', 'for', 'and', 'of', 'in', 'on', 'a', 'an', 'by', 'to', 'new', 'latest', 'all', 'combo', 'pack', 'set',
  'edition', 'version', 'model', 'genuine', 'original', 'official', 'india', 'indian', '5g', '4g', 'lte', 'dual', 'sim',
  'wireless', 'bluetooth', 'true', 'tws', 'free', 'delivery', 'size', 'color', 'colour', 'mic', 'buy', 'online', 'best',
  'price', 'deal', 'offer', 'sale', 'only', 'upto', 'up', 'off', 'x', 'w', 'without', 'from',
]);
// Words that turn one product into a different one when only one side has them.
const VARIANTS = new Set([
  'pro', 'max', 'plus', 'ultra', 'mini', 'lite', 'fe', 'air', 'neo', 'se', 'prime', 'anc', 'enc',
  'men', 'women', 'kids', 'boys', 'girls', 'unisex',
]);
const ALIASES = { mens: 'men', man: 'men', womens: 'women', woman: 'women', ladies: 'women', kid: 'kids', boy: 'boys', girl: 'girls' };
const SPEC = /^(\d+(?:\.\d+)?)(gb|tb|mah|kg|ml|l|w|inch|cm|mm|hz|g)$/;

export function productTokens(title) {
  let s = String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '')
    .replace(/\+/g, ' plus ');
  // "128 GB" → "128gb", "6.1 inches" → "6.1inch"
  s = s.replace(/(\d+(?:\.\d+)?)\s*(gb|tb|mah|kg|ml|l|w|inches|inch|cm|mm|hz|g)\b/g, (_, n, u) => `${n}${u === 'inches' ? 'inch' : u}`);

  const words = new Set();
  const models = new Set();
  const variants = new Set();
  const specs = new Map(); // unit → Set of values

  const raw = [];
  for (let chunk of s.split(/[^a-z0-9.-]+/)) {
    chunk = chunk.replace(/^[.-]+|[.-]+$/g, '');
    if (!chunk) continue;
    if (/\d/.test(chunk)) raw.push(SPEC.test(chunk) ? chunk : chunk.replace(/-/g, '').replace(/\.(?!\d)|(?<!\d)\./g, ''));
    else raw.push(...chunk.split(/[-.]+/));
  }
  for (let t of raw) {
    if (!t) continue;
    t = ALIASES[t] || t;
    if (!/\d/.test(t) && t.length > 4 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1); // plurals
    if (NOISE.has(t) || COLORS.has(t)) continue;
    if (VARIANTS.has(t)) {
      variants.add(t);
      words.add(t);
      continue;
    }
    const spec = t.match(SPEC);
    if (spec) {
      if (!specs.has(spec[2])) specs.set(spec[2], new Set());
      specs.get(spec[2]).add(spec[1]);
    } else if (/\d/.test(t) && (/[a-z]/.test(t) || t.length >= 2)) models.add(t);
    else if (t.length >= 2) words.add(t);
  }
  return { words, models, variants, specs };
}

const intersects = (a, b) => [...a].some((x) => b.has(x));
const subset = (a, b) => [...a].every((x) => b.has(x));
const sameSet = (a, b) => a.size === b.size && subset(a, b);
const normCode = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Similarity in [0, 1] between two products ({ title, gtin?, mpn?, tokens? }). */
export function productScore(a, b) {
  if (a.gtin && b.gtin) return a.gtin === b.gtin ? 1 : 0;
  if (normCode(a.mpn) && normCode(a.mpn) === normCode(b.mpn)) return 0.95;

  const A = a.tokens || productTokens(a.title);
  const B = b.tokens || productTokens(b.title);
  if (!sameSet(A.variants, B.variants)) return 0;
  for (const [unit, va] of A.specs) {
    const vb = B.specs.get(unit);
    if (vb && !subset(va, vb) && !subset(vb, va)) return 0;
  }
  if (A.models.size && B.models.size && !intersects(A.models, B.models)) return 0;

  const has = (T, t) => T.words.has(t) || T.models.has(t);
  let inter = 0;
  let union = 0;
  for (const t of new Set([...A.words, ...A.models, ...B.words, ...B.models])) {
    const w = A.models.has(t) || B.models.has(t) ? 3 : 1; // model numbers carry the most weight
    union += w;
    if (has(A, t) && has(B, t)) inter += w;
  }
  let score = union ? inter / union : 0;

  // Same model number + at least one shared name word ("sony", "iphone") is a strong match even
  // when the rest of the titles are worded very differently across retailers.
  const nameWords = (T) => new Set([...T.words].filter((w) => !VARIANTS.has(w)));
  if (intersects(A.models, B.models) && intersects(nameWords(A), nameWords(B))) score = Math.max(score, 0.8);
  // Without any model number, titles alone can't prove two products are identical.
  if (!A.models.size && !B.models.size) score = Math.min(score, 0.7);
  return score;
}

export const HIGH_CONFIDENCE = 0.75;
export const MIN_SUGGEST = 0.5;

export function confidence(score) {
  return score >= HIGH_CONFIDENCE ? 'high' : score >= MIN_SUGGEST ? 'medium' : null;
}
