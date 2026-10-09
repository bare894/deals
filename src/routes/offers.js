// Store listings ("offers") on a deal: anyone can add their store's link to an existing product
// deal; each listing is owned by its poster (whose link — and affiliate tag — is preserved).
import { tx } from '../db.js';
import { HttpError } from '../http.js';
import { duplicateLinkError } from '../repo.js';
import { resolveLink, validateOfferBody } from './common.js';

export function registerOfferRoutes({ route, db, repo, rateLimit, resolveUrl }) {
  route('POST', '/api/deals/:id/offers', { auth: true, active: true }, async ({ params, body, user }) => {
    rateLimit('submit', user.id);
    const dealId = Number(params.id);
    const link = await resolveLink(body.url, resolveUrl);
    const offer = validateOfferBody(body);
    const dup = repo.findActiveOfferByHash(link.hash);
    if (dup) throw duplicateLinkError(dup);
    const gtin = /^\d{8,14}$/.test(String(body.gtin || '')) ? String(body.gtin).padStart(14, '0') : null;
    const offerId = repo.addOffer(dealId, user.id, link, offer, { gtin, mpn: body.mpn ? String(body.mpn).slice(0, 64) : null });
    return { offer: repo.serializeOffer(repo.getOfferRow(offerId)), deal: repo.getDeal(dealId) };
  });

  function ownOffer(id, user) {
    const o = repo.getOfferRow(id);
    if (!o || o.status !== 'active') throw new HttpError(404, 'Store listing not found');
    if (o.submitted_by !== user.id) throw new HttpError(403, 'You can only change store links you posted');
    return o;
  }

  // The link itself isn't editable — remove the listing and add a new one instead — so a
  // listing can't be swapped to a different product after it has collected trust.
  route('PATCH', '/api/offers/:id', { auth: true, active: true }, ({ params, body, user }) => {
    const o = ownOffer(Number(params.id), user);
    const f = validateOfferBody(body);
    tx(db, () => {
      db.prepare('UPDATE offers SET price_cents = ?, full_price_cents = ?, store = ?, note = ?, updated_at = ? WHERE id = ?').run(
        f.price, f.fullPrice, f.store, f.note, Date.now(), o.id,
      );
      repo.refreshDealPricing(o.deal_id);
    });
    return { offer: repo.serializeOffer(repo.getOfferRow(o.id)) };
  });

  route('DELETE', '/api/offers/:id', { auth: true, active: true }, ({ params, user }) => {
    const o = ownOffer(Number(params.id), user);
    repo.setOfferStatus(o.id, 'removed', user.id);
    return { ok: true };
  });
}
