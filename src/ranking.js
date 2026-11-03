// Discovery ranking (PRD §6). Both formulas are first-cut answers to Open Questions #1 and #2
// and are intentionally isolated here so they can be tuned without touching the API.

const HOUR = 3_600_000;
export const HOT_GRAVITY = 1.5;
export const HOT_WINDOW_MS = 14 * 24 * HOUR;

/** Hacker-News-style time decay: net score / (age_hours + 2)^gravity. */
export function hotScore(score, createdAt, now = Date.now()) {
  const ageHours = Math.max(0, (now - createdAt) / HOUR);
  return score / Math.pow(ageHours + 2, HOT_GRAVITY);
}

export function rankHot(deals, now = Date.now()) {
  return deals
    .map((d) => ({ d, h: hotScore(d.score, d.created_at, now) }))
    .sort((a, b) => b.h - a.h || b.d.created_at - a.d.created_at)
    .map(({ d }) => d);
}

/**
 * "For You": what the user has shown interest in, applied to hot-ranked candidates.
 *   Category affinity: bookmark +3, upvote +2, downvote −2, comment +1, and page visits —
 *   a deal page +1, a category page +1.5 — fading with a 14-day half-life.
 *   Product affinity: words from the titles of deals they've opened (brands, product types),
 *   so a Sony headphones visitor sees other Sony and headphone deals across categories.
 *   Store affinity: stores whose deals or store pages they visit.
 * Deals the user already voted on, bookmarked, or posted are excluded; deals they opened in the
 * last few days are pushed down so the section keeps showing something new.
 */
const SIGNAL_WEIGHTS = { bookmark: 3, upvote: 2, downvote: -2, comment: 1, view: 0.5 };
const VIEW_HALF_LIFE_MS = 14 * 24 * HOUR;
const RECENTLY_SEEN_MS = 3 * 24 * HOUR;
const TITLE_STOPWORDS = new Set(['the', 'and', 'with', 'for', 'new', 'all', 'pack', 'set', 'combo', 'men', 'women', 'black', 'white', 'blue', 'size', 'from', 'off', 'free']);

/** Distinctive lowercase words of a deal title ("Sony WH-1000XM6 Headphones" → sony, 1000xm6, headphones). */
export function titleWords(title) {
  return new Set(String(title || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !TITLE_STOPWORDS.has(w) && !/^\d+$/.test(w)));
}

export function categoryAffinity(signals) {
  const aff = new Map();
  for (const { category_id, kind, n } of signals) {
    if (category_id == null) continue;
    aff.set(category_id, (aff.get(category_id) || 0) + SIGNAL_WEIGHTS[kind] * n);
  }
  return aff;
}

/**
 * Interest profile from page views ({ deal_id, deal_title, deal_category_id, category_id, store,
 * viewed_at }), newest first, layered on the category affinity from votes/saves/comments.
 */
export function interestProfile(pageViews, affinity = new Map(), now = Date.now()) {
  const category = new Map(affinity);
  const words = new Map();
  const stores = new Map();
  const seen = new Map();
  const add = (map, key, w) => key != null && map.set(key, (map.get(key) || 0) + w);
  for (const v of pageViews) {
    const fade = Math.pow(0.5, Math.max(0, now - v.viewed_at) / VIEW_HALF_LIFE_MS);
    if (v.deal_id) {
      add(category, v.deal_category_id, 1 * fade);
      for (const w of titleWords(v.deal_title)) add(words, w, fade);
      if (!seen.has(v.deal_id)) seen.set(v.deal_id, v.viewed_at);
    } else if (v.category_id) {
      add(category, v.category_id, 1.5 * fade);
    }
    add(stores, v.store, 0.5 * fade);
  }
  return { category, words, stores, seen };
}

export const hasInterests = (p) => [...p.category.values()].some((v) => v > 0) || p.words.size > 0 || p.stores.size > 0;

export function rankForYou(candidates, profile, now = Date.now()) {
  // Older callers pass a bare category-affinity map.
  if (profile instanceof Map) profile = { category: profile, words: new Map(), stores: new Map(), seen: new Map() };
  const norm = (m) => Math.max(1, ...m.values());
  const maxCat = norm(profile.category);
  const maxWord = norm(profile.words);
  const maxStore = norm(profile.stores);
  return candidates
    .map((d) => {
      const cat = Math.max(0, profile.category.get(d.category_id) || 0) / maxCat; // 0..1
      let sim = 0;
      for (const w of titleWords(d.title)) sim += (profile.words.get(w) || 0) / maxWord;
      sim = Math.min(sim, 2) / 2; // 0..1: a couple of strong shared words is plenty
      const store = (profile.stores.get(d.best_store) || 0) / maxStore;
      const seenAt = profile.seen.get(d.id);
      const fresh = seenAt && now - seenAt < RECENTLY_SEEN_MS ? 0.3 : 1;
      const h = hotScore(Math.max(d.score, 0) + 1, d.created_at, now);
      return { d, r: (0.15 + cat + 1.2 * sim + 0.2 * store) * h * fresh };
    })
    .sort((x, y) => y.r - x.r)
    .map(({ d }) => d);
}

/**
 * How closely one deal matches a user's interests, 0 (not at all) to about 2.4, ignoring how
 * hot it is. Deal alerts go out above ALERT_THRESHOLD: roughly, a deal in one of their top
 * categories, or one sharing a brand and product type with deals they've opened.
 */
export const ALERT_THRESHOLD = 0.9;
export function interestMatch(d, profile) {
  const norm = (m) => Math.max(1, ...m.values());
  const cat = Math.max(0, profile.category.get(d.category_id) || 0) / norm(profile.category);
  let sim = 0;
  for (const w of titleWords(d.title)) sim += (profile.words.get(w) || 0) / norm(profile.words);
  const store = (profile.stores.get(d.best_store) || 0) / norm(profile.stores);
  return cat + 1.2 * (Math.min(sim, 2) / 2) + 0.2 * store;
}
