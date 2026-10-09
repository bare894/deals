// Consumer-facing deal routes: discovery, detail, posting, voting, comments, bookmarks, reports.
import { tx } from '../db.js';
import { HttpError, intParam, str } from '../http.js';
import { duplicateLinkError, storeConflictError } from '../repo.js';
import { REPORT_REASONS, isMod, resolveLink, validateDealBody, validateOfferBody } from './common.js';

export function registerDealRoutes({ route, db, repo, rateLimit, scraper, resolveUrl }) {
  // ------------------------------------------------------------ discovery (§6, §7)

  route('GET', '/api/home', async ({ user }) => {
    const [latest, hot, fy] = await Promise.all([repo.latest(12), repo.hotSlice(12), repo.forYou(user, 12)]);
    for (const list of [latest, hot, fy.items]) await repo.attachMyVotes(list, user);
    return { latest, hot, forYou: fy.items, forYouPersonalized: fy.personalized };
  });

  route('GET', '/api/deals', ({ query, user }) =>
    repo.listDeals({
      sort: query.get('sort') === 'hot' ? 'hot' : 'new',
      categorySlug: query.get('category') || null,
      q: (query.get('q') || '').trim().slice(0, 100) || null,
      page: intParam(query.get('page'), 1, { max: 500 }),
      limit: intParam(query.get('limit'), 20, { max: 50 }),
      user,
    }),
  );

  // ------------------------------------------------------------ deal detail (§8)

  route('GET', '/api/deals/:id', async ({ params, user }) => {
    const row = await repo.getDealRow(Number(params.id));
    if (row?.merged_into) return { mergedInto: row.merged_into };
    if (!row || (row.status !== 'active' && !isMod(user))) throw new HttpError(404, 'This deal is no longer available');
    const deal = await repo.getDeal(row.id, { includeRemovedOffers: isMod(user) });
    deal.myVote = 0;
    deal.bookmarked = false;
    deal.canEdit = Boolean(user && user.id === row.submitted_by && row.status === 'active');
    if (user) {
      deal.myVote = (await db.get('SELECT value FROM votes WHERE deal_id = ? AND user_id = ?', row.id, user.id))?.value || 0;
      deal.bookmarked = Boolean(await db.get('SELECT 1 FROM bookmarks WHERE deal_id = ? AND user_id = ?', row.id, user.id));
      await db.run(
        'INSERT INTO views (user_id, deal_id, viewed_at) VALUES (?, ?, ?) ON CONFLICT (user_id, deal_id) DO UPDATE SET viewed_at = excluded.viewed_at',
        user.id, row.id, Date.now(),
      );
    }
    return { deal };
  });

  // ------------------------------------------------------------ posting (§9, §10)

  /**
   * Step 1 of posting: dedup the exact link, scrape the page, and look for the same product
   * already posted from another store. With `dealId`, the user is adding a store to that deal.
   */
  route('POST', '/api/deals/prefill', { auth: true, active: true }, async ({ body, user }) => {
    rateLimit('scrape', user.id);
    const link = await resolveLink(body.url, resolveUrl);
    const dup = await repo.findActiveOfferByHash(link.hash);
    if (dup) throw duplicateLinkError(dup);
    const dealId = Number(body.dealId) || 0;
    if (dealId) {
      const existing = await repo.storeOnDeal(dealId, link.storeKey);
      if (existing) throw storeConflictError(existing);
    }
    const result = await scraper(link.resolved.href);
    const matches = dealId ? [] : await repo.findMatches(result.fields, { storeKey: link.storeKey });
    return { ok: result.ok, reason: result.reason, fields: result.fields, url: link.url.href, storeKey: link.storeKey, matches };
  });

  route('POST', '/api/deals', { auth: true, active: true }, async ({ body, user }) => {
    rateLimit('submit', user.id);
    const link = await resolveLink(body.url, resolveUrl);
    const deal = await validateDealBody(db, body);
    const offer = validateOfferBody(body);
    const dup = await repo.findActiveOfferByHash(link.hash);
    if (dup) throw duplicateLinkError(dup);
    // Same product already posted from another store? Steer the user to add their link to it.
    // Enforced here (not just in the UI) so every client — web, app, extension — follows it.
    if (body.confirmNew !== true) {
      const matches = (await repo.findMatches(deal, { storeKey: link.storeKey })).filter((m) => m.confidence === 'high');
      if (matches.length) {
        throw new HttpError(409, 'This product looks like it has already been posted — add your store link to the existing deal instead.', { matches });
      }
    }
    const id = await repo.createDealWithOffer(user.id, deal, link, offer);
    return { deal: await repo.getDeal(id) };
  });

  // Product-level edits belong to the deal's creator; store listings are edited by their posters.
  route('PATCH', '/api/deals/:id', { auth: true, active: true }, async ({ params, body, user }) => {
    const row = await repo.getDealRow(Number(params.id));
    if (!row || row.status !== 'active') throw new HttpError(404, 'Deal not found');
    if (row.submitted_by !== user.id) throw new HttpError(403, 'Only the person who posted this deal can edit its details');
    const d = await validateDealBody(db, body);
    await db.run(
      'UPDATE deals SET title = ?, image_url = ?, category_id = ?, details = ?, gtin = COALESCE(?, gtin), mpn = COALESCE(?, mpn), updated_at = ? WHERE id = ?',
      d.title, d.imageUrl, d.categoryId, d.details, d.gtin, d.mpn, Date.now(), row.id,
    );
    return { deal: await repo.getDeal(row.id) };
  });

  // ------------------------------------------------------------ voting (§11)

  route('POST', '/api/deals/:id/vote', { auth: true, active: true }, ({ params, body, user }) => {
    rateLimit('vote', user.id);
    const value = Number(body.value);
    if (![1, -1, 0].includes(value)) throw new HttpError(400, 'Vote must be 1, -1, or 0');
    const dealId = Number(params.id);
    return tx(db, async () => {
      // Row lock: concurrent votes on one deal take turns, so the counters stay exact.
      const deal = await db.get('SELECT id, submitted_by, status FROM deals WHERE id = ? FOR UPDATE', dealId);
      if (!deal || deal.status !== 'active') throw new HttpError(404, 'Deal not found');
      // Self-votes excluded to reduce gaming (PRD §11 recommendation, Open Q #6).
      if (deal.submitted_by === user.id) throw new HttpError(403, "You can't vote on your own deal");
      const prev = (await db.get('SELECT value FROM votes WHERE deal_id = ? AND user_id = ?', dealId, user.id))?.value || 0;
      if (prev !== value) {
        if (value === 0) await db.run('DELETE FROM votes WHERE deal_id = ? AND user_id = ?', dealId, user.id);
        else
          await db.run(
            'INSERT INTO votes (deal_id, user_id, value, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (deal_id, user_id) DO UPDATE SET value = excluded.value',
            dealId, user.id, value, Date.now(),
          );
        const up = (value === 1 ? 1 : 0) - (prev === 1 ? 1 : 0);
        const down = (value === -1 ? 1 : 0) - (prev === -1 ? 1 : 0);
        await db.run('UPDATE deals SET upvotes = upvotes + ?, downvotes = downvotes + ?, score = score + ? WHERE id = ?', up, down, up - down, dealId);
      }
      const d = await db.get('SELECT upvotes, downvotes, score FROM deals WHERE id = ?', dealId);
      return { myVote: value, score: d.score, upvotes: d.upvotes, downvotes: d.downvotes };
    });
  });

  // ------------------------------------------------------------ comments (§12)

  route('GET', '/api/deals/:id/comments', async ({ params }) => {
    const rows = await db.all(
      `SELECT c.id, c.body, c.created_at, u.id AS user_id, u.handle, u.role FROM comments c JOIN users u ON u.id = c.user_id
        WHERE c.deal_id = ? AND c.status = 'visible' ORDER BY c.created_at ASC LIMIT 500`,
      Number(params.id),
    );
    return { comments: rows.map((r) => ({ id: r.id, body: r.body, createdAt: r.created_at, author: { id: r.user_id, handle: r.handle, role: r.role } })) };
  });

  route('POST', '/api/deals/:id/comments', { auth: true, active: true }, async ({ params, body, user }) => {
    rateLimit('comment', user.id);
    const text = str(body.body, 'Comment', { required: true, max: 2000 });
    const deal = await db.get('SELECT status FROM deals WHERE id = ?', Number(params.id));
    if (!deal || deal.status !== 'active') throw new HttpError(404, 'Deal not found');
    const now = Date.now();
    const { id } = await db.get('INSERT INTO comments (deal_id, user_id, body, created_at) VALUES (?, ?, ?, ?) RETURNING id', Number(params.id), user.id, text, now);
    return { comment: { id, body: text, createdAt: now, author: { id: user.id, handle: user.handle, role: user.role } } };
  });

  // ------------------------------------------------------------ reports (user flagging)

  const REPORTABLE = {
    deal: ['deals', 'active'],
    comment: ['comments', 'visible'],
    offer: ['offers', 'active'],
  };
  async function report(targetType, targetId, user, body) {
    rateLimit('report', user.id);
    const reason = String(body.reason || '');
    if (!REPORT_REASONS.includes(reason)) throw new HttpError(400, 'Please choose a reason');
    const note = str(body.note, 'Note', { max: 300 });
    const [table, okStatus] = REPORTABLE[targetType];
    const target = await db.get(`SELECT status FROM ${table} WHERE id = ?`, targetId);
    if (!target || target.status !== okStatus) throw new HttpError(404, 'Not found');
    await db.run(
      `INSERT INTO reports (reporter_id, target_type, target_id, reason, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (reporter_id, target_type, target_id) DO UPDATE SET reason = excluded.reason, status = 'open', created_at = excluded.created_at`,
      user.id, targetType, targetId, note ? `${reason}: ${note}` : reason, Date.now(),
    );
    return { ok: true };
  }
  route('POST', '/api/deals/:id/report', { auth: true }, ({ params, body, user }) => report('deal', Number(params.id), user, body));
  route('POST', '/api/comments/:id/report', { auth: true }, ({ params, body, user }) => report('comment', Number(params.id), user, body));
  route('POST', '/api/offers/:id/report', { auth: true }, ({ params, body, user }) => report('offer', Number(params.id), user, body));

  // ------------------------------------------------------------ bookmarks (§13) & profile

  route('PUT', '/api/deals/:id/bookmark', { auth: true }, async ({ params, user }) => {
    const deal = await db.get('SELECT status FROM deals WHERE id = ?', Number(params.id));
    if (!deal || deal.status !== 'active') throw new HttpError(404, 'Deal not found');
    await db.run('INSERT INTO bookmarks (user_id, deal_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', user.id, Number(params.id), Date.now());
    return { bookmarked: true };
  });

  route('DELETE', '/api/deals/:id/bookmark', { auth: true }, async ({ params, user }) => {
    await db.run('DELETE FROM bookmarks WHERE user_id = ? AND deal_id = ?', user.id, Number(params.id));
    return { bookmarked: false };
  });

  route('GET', '/api/me/bookmarks', { auth: true }, async ({ user }) => {
    // Removed deals stay in the wishlist with a "No longer available" state (§13).
    const rows = await db.all(`${repo.DEAL_SELECT} JOIN bookmarks b ON b.deal_id = d.id AND b.user_id = ? ORDER BY b.created_at DESC`, user.id);
    return { items: await repo.attachMyVotes(rows.map((r) => repo.serializeDeal(r)), user) };
  });

  // Deals the user started, plus deals where they added a store link.
  route('GET', '/api/me/deals', { auth: true }, async ({ user }) => {
    const rows = await db.all(
      `${repo.DEAL_SELECT}
        WHERE d.merged_into IS NULL AND (d.submitted_by = ? OR EXISTS (SELECT 1 FROM offers o WHERE o.deal_id = d.id AND o.submitted_by = ? AND o.status != 'deal_removed'))
        ORDER BY d.created_at DESC LIMIT 200`,
      user.id, user.id,
    );
    return { items: rows.map((r) => ({ ...repo.serializeDeal(r), role: r.submitted_by === user.id ? 'creator' : 'contributor' })) };
  });
}
