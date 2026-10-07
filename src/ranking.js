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
 * "For You": per-category affinity from the user's own behavior, applied to hot-ranked candidates.
 *   bookmark +3, upvote +2, downvote −2, comment +1, view +0.5
 * Deals the user already voted on, bookmarked, or posted are excluded.
 */
export function categoryAffinity(signals) {
  const weights = { bookmark: 3, upvote: 2, downvote: -2, comment: 1, view: 0.5 };
  const aff = new Map();
  for (const { category_id, kind, n } of signals) {
    if (category_id == null) continue;
    aff.set(category_id, (aff.get(category_id) || 0) + weights[kind] * n);
  }
  return aff;
}

export function rankForYou(candidates, affinity, now = Date.now()) {
  const max = Math.max(1, ...affinity.values());
  return candidates
    .map((d) => {
      const a = Math.max(0, affinity.get(d.category_id) || 0) / max; // 0..1
      const h = hotScore(Math.max(d.score, 0) + 1, d.created_at, now);
      return { d, r: (0.15 + a) * h };
    })
    .sort((x, y) => y.r - x.r)
    .map(({ d }) => d);
}
