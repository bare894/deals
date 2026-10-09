import { HttpError, str, toCents } from '../http.js';
import { canonicalizeUrl, hashUrl, parseDealUrl, registrableDomain } from '../canonicalize.js';

export const ROLE_RANK = { user: 0, moderator: 1, admin: 2 };
export const isMod = (user) => Boolean(user && ROLE_RANK[user.role] >= ROLE_RANK.moderator);
export const REPORT_REASONS = ['spam', 'expired', 'wrong_price', 'duplicate', 'offensive', 'other'];

export function publicUser(u) {
  return u ? { id: u.id, handle: u.handle, email: u.email, role: u.role, status: u.status } : null;
}

/** Validate + canonicalize a pasted product link. storeKey identifies the store (e.g. flipkart.com). */
export async function resolveLink(rawUrl, resolveUrl) {
  let url;
  try {
    url = parseDealUrl(rawUrl);
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  const resolved = await resolveUrl(url);
  const canonicalUrl = canonicalizeUrl(resolved);
  return { url, resolved, canonicalUrl, hash: hashUrl(canonicalUrl), storeKey: registrableDomain(new URL(canonicalUrl).hostname) };
}

/** Product-level fields (shared by every store listing). */
export function validateDealBody(db, body) {
  const categoryId = Number(body.categoryId);
  const category = Number.isInteger(categoryId) ? db.prepare('SELECT id FROM categories WHERE id = ? AND active = 1').get(categoryId) : null;
  if (!category) throw new HttpError(400, 'Please choose a category');
  let imageUrl = str(body.imageUrl, 'Image URL', { max: 2000 });
  if (imageUrl && !imageUrl.startsWith('/img/placeholder.svg?')) {
    try {
      const u = new URL(imageUrl);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
      imageUrl = u.href;
    } catch {
      throw new HttpError(400, 'Image URL must be a valid http(s) link');
    }
  }
  const gtin = /^\d{8,14}$/.test(String(body.gtin || '')) ? String(body.gtin).padStart(14, '0') : null;
  return {
    title: str(body.title, 'Title', { required: true, min: 3, max: 200 }),
    imageUrl: imageUrl || null,
    categoryId,
    details: str(body.details, 'Details', { max: 5000 }),
    gtin,
    mpn: str(body.mpn, 'MPN', { max: 64 }) || null,
  };
}

/** Store-listing fields (one store's price for the product). */
export function validateOfferBody(body) {
  const price = toCents(body.price, 'Deal price', { required: true });
  const fullPrice = toCents(body.fullPrice, 'MRP');
  if (fullPrice != null && fullPrice < price) throw new HttpError(400, 'MRP should be higher than the deal price');
  return {
    price,
    fullPrice,
    store: str(body.store, 'Store', { required: true, max: 80 }),
    note: str(body.note, 'Offer note', { max: 300 }),
  };
}
