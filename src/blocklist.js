// Prohibited products: adult/sexual, weapons and offensive items are refused outright when a deal or
// store link is posted or edited (no moderation queue). Matched against the title, details, store
// note and the link itself. Admins keep the list in Admin Mode → Blocked words: "block" terms refuse
// a post; "allow" phrases carve out harmless uses ("massage gun" while "gun" is blocked).
import { HttpError } from './http.js';

export const BLOCKED_MESSAGE = "ShareDeals doesn't allow adult, sexual, offensive or weapon-related products, so this can't be posted.";

/** Lowercase words separated by single spaces, with a space at each end so terms match whole words. */
export function normalizeText(text) {
  const words = String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return ` ${words} `;
}

const termPattern = (term) => {
  const n = normalizeText(term).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return n ? new RegExp(`(?<= )${n}(?:s|es)?(?= )`, 'g') : null; // plurals too: "vibrators", "pistols"
};

/** The first blocked term found in `texts` (after removing allowed phrases), or null. */
export function findBlocked(texts, { block = [], allow = [] }) {
  let hay = normalizeText(texts.filter(Boolean).join(' '));
  for (const a of allow) {
    const re = termPattern(a);
    if (re) hay = hay.replace(re, ' ');
  }
  for (const b of block) {
    const re = termPattern(b);
    if (re && re.test(hay)) return b;
  }
  return null;
}

export function createBlocklist(db) {
  async function terms() {
    const rows = await db.all('SELECT term, kind FROM blocked_terms');
    return { block: rows.filter((r) => r.kind === 'block').map((r) => r.term), allow: rows.filter((r) => r.kind === 'allow').map((r) => r.term) };
  }
  return {
    terms,
    find: async (...texts) => findBlocked(texts, await terms()),
    /** Throws 400 if any of the texts mentions a blocked product. */
    async assertAllowed(...texts) {
      if (findBlocked(texts, await terms())) throw new HttpError(400, BLOCKED_MESSAGE, { blocked: true });
    },
  };
}
