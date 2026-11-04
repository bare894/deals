// Consumer-facing deal routes: discovery, detail, posting, voting, comments, bookmarks, reports.
import { tx } from '../db.js';
import { HttpError, intParam, str } from '../http.js';
import { duplicateLinkError, storeConflictError } from '../repo.js';
import { extractDealFields } from '../scrape.js';
import { REPORT_REASONS, isMod, resolveLink, validateDealBody, validateOfferBody } from './common.js';

export function registerDealRoutes({ route, db, repo, seo, push, rateLimit, scraper, resolveUrl, approvedStores, blocklist }) {
  // ------------------------------------------------------------ discovery (§6, §7)

  route('GET', '/api/home', async ({ user }) => {
    const [latest, hot, fy, blocked] = await Promise.all([repo.latest(100), repo.hotSlice(10), repo.forYou(user, 12), repo.blockedIds(user)]);
    const visible = (list) => list.filter((d) => !blocked.has(d.poster.id));
    const lists = { latest: visible(latest), hot: visible(hot), forYou: visible(fy.items) };
    for (const list of Object.values(lists)) await repo.attachMyVotes(list, user);
    return { ...lists, forYouPersonalized: fy.personalized };
  });

  route('GET', '/api/deals', async ({ query, user }) =>
    repo.listDeals({
      sort: query.get('sort') === 'hot' ? 'hot' : 'new',
      categorySlug: query.get('category') || null,
      storeName: query.get('store') ? (await seo.storeBySlug(query.get('store')))?.name ?? '\u0000' : null,
      q: (query.get('q') || '').trim().slice(0, 100) || null,
      page: intParam(query.get('page'), 1, { max: 500 }),
      limit: intParam(query.get('limit'), 20, { max: 50 }),
      user,
    }),
  );

  route('GET', '/api/deals/:id/similar', async ({ params, user }) => {
    const blocked = await repo.blockedIds(user);
    const items = (await repo.similar(Number(params.id), 10 + blocked.size)).filter((d) => !blocked.has(d.poster.id)).slice(0, 10);
    return { items: await repo.attachMyVotes(items, user) };
  });

  // Blocking: a user hides everything another user posts (deals, comments, alerts about their deals).
  route('GET', '/api/blocks', { auth: true }, async ({ user }) => ({
    items: (await db.all('SELECT u.id, u.handle, b.created_at FROM user_blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC', user.id))
      .map((r) => ({ id: r.id, handle: r.handle, blockedAt: r.created_at })),
  }));

  route('POST', '/api/blocks', { auth: true }, async ({ body, user }) => {
    const id = Number(body.userId);
    if (!Number.isInteger(id) || id === user.id) throw new HttpError(400, "You can't block yourself");
    const target = await db.get("SELECT id, handle FROM users WHERE id = ? AND status <> 'deleted'", id);
    if (!target) throw new HttpError(404, 'User not found');
    await db.run('INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', user.id, id, Date.now());
    return { ok: true, handle: target.handle };
  });

  route('DELETE', '/api/blocks/:userId', { auth: true }, async ({ params, user }) => {
    await db.run('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', user.id, Number(params.userId));
    return { ok: true };
  });

  /**
   * Page-view log for signed-in users (one row per page opened), used to personalise For You.
   * The app sends the path; we work out the deal, category or store it shows. Signed-out
   * visits aren't stored, and Admin pages are skipped.
   */
  route('POST', '/api/pageview', async ({ body, user }) => {
    if (!user) return { ok: true };
    rateLimit('pageview', user.id);
    const path = str(body.path, 'Path', { max: 300 }).split('?')[0];
    if (!path.startsWith('/') || path.startsWith('/admin')) return { ok: true };
    let dealId = null;
    let categoryId = null;
    let store = null;
    const deal = path.match(/^\/deals\/(\d{1,9})(?:\/[a-z0-9-]+)?$/);
    const cat = path.match(/^\/c\/([a-z0-9-]+)$/);
    const shop = path.match(/^\/store\/([a-z0-9-]+)$/);
    if (deal && deal[0].split('/')[3] !== 'edit') {
      const row = await db.get("SELECT id, category_id, best_store FROM deals WHERE id = ? AND status = 'active'", Number(deal[1]));
      if (row) [dealId, categoryId, store] = [row.id, row.category_id, row.best_store];
    } else if (cat) {
      categoryId = (await db.get('SELECT id FROM categories WHERE slug = ?', cat[1]))?.id ?? null;
    } else if (shop) {
      store = (await seo.storeBySlug(shop[1]))?.name ?? null;
    }
    await db.run(
      'INSERT INTO page_views (user_id, path, deal_id, category_id, store, viewed_at) VALUES (?, ?, ?, ?, ?, ?)',
      user.id, path, dealId, categoryId, store, Date.now(),
    );
    return { ok: true };
  });

  // Android app: the device's push token for the signed-in user (deal alerts). DELETE on sign-out.
  route('POST', '/api/push/token', { auth: true }, async ({ body, user }) => {
    const token = str(body.token, 'Token', { required: true, max: 4096 });
    const now = Date.now();
    await db.run(
      `INSERT INTO push_tokens (token, user_id, platform, created_at, updated_at) VALUES (?, ?, 'android', ?, ?)
       ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id, updated_at = excluded.updated_at`,
      token, user.id, now, now,
    );
    return { ok: true };
  });

  route('DELETE', '/api/push/token', {}, async ({ body }) => {
    await db.run('DELETE FROM push_tokens WHERE token = ?', str(body.token, 'Token', { max: 4096 }));
    return { ok: true };
  });

  route('GET', '/api/stores', async () => ({ stores: await seo.stores() }));

  // ------------------------------------------------------------ deal detail (§8)

  route('GET', '/api/deals/:id', async ({ params, user }) => {
    const row = await repo.getDealRow(Number(params.id));
    if (row?.merged_into) return { mergedInto: row.merged_into };
    if (!row || (row.status !== 'active' && !isMod(user))) throw new HttpError(404, 'This deal is no longer available');
    const deal = await repo.getDeal(row.id, { includeRemovedOffers: isMod(user) });
    deal.myVote = 0;
    deal.bookmarked = false;
    deal.canEdit = Boolean(user && user.id === row.submitted_by && row.status === 'active');
    deal.posterBlocked = Boolean(user && (await db.get('SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', user.id, row.submitted_by)));
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
   * `html` (optional) is the browser extension's snapshot of the page as the user sees it: read
   * first, since stores often block requests from servers; we only fetch to fill gaps.
   */
  route('POST', '/api/deals/prefill', { auth: true, active: true, maxBody: 1_000_000 }, async ({ body, user }) => {
    if (!isMod(user)) rateLimit('scrape', user.id); // staff seed deals in bulk
    const link = await resolveLink(body.url, resolveUrl, approvedStores);
    const dup = await repo.findActiveOfferByHash(link.hash);
    if (dup) throw duplicateLinkError(dup);
    const dealId = Number(body.dealId) || 0;
    if (dealId) {
      const existing = await repo.storeOnDeal(dealId, link.storeKey);
      if (existing) throw storeConflictError(existing);
    }
    let result = null;
    if (typeof body.html === 'string' && body.html.length) {
      const f = extractDealFields(body.html, link.resolved.href);
      if (f.title || f.price != null) result = { ok: true, reason: null, fields: f };
    }
    if (!result || !result.fields.title || result.fields.price == null || !result.fields.imageUrl) {
      const fetched = await scraper(link.resolved.href);
      if (!result) result = fetched;
      else for (const [k, v] of Object.entries(fetched.fields || {})) if ((result.fields[k] ?? '') === '' && v != null && v !== '') result.fields[k] = v;
    }
    const fields = { ...result.fields };
    // Prohibited products are refused here, before the user fills in the form.
    await blocklist.assertAllowed(link.url.href, link.resolved.href, fields.title);
    // The scraper names one of the site's categories; the form needs its id (admins can hide/rename them).
    if (fields.category) {
      fields.categoryId = (await db.get('SELECT id FROM categories WHERE lower(name) = lower(?) AND active = 1', fields.category))?.id ?? null;
    }
    const matches = dealId ? [] : await repo.findMatches(fields, { storeKey: link.storeKey });
    return { ok: result.ok, reason: result.reason, fields, url: link.url.href, storeKey: link.storeKey, matches };
  });

  route('POST', '/api/deals', { auth: true, active: true }, async ({ body, user }) => {
    if (!isMod(user)) rateLimit('submit', user.id);
    const link = await resolveLink(body.url, resolveUrl, approvedStores);
    const deal = await validateDealBody(db, body);
    const offer = validateOfferBody(body);
    await blocklist.assertAllowed(link.url.href, link.resolved.href, deal.title, deal.details, offer.note);
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
    // Deal alerts to app users it matches; in the background so posting stays fast.
    setImmediate(() => push?.notifyNewDeal(id));
    return { deal: await repo.getDeal(id) };
  });

  // Product-level edits belong to the deal's creator; store listings are edited by their posters.
  route('PATCH', '/api/deals/:id', { auth: true, active: true }, async ({ params, body, user }) => {
    const row = await repo.getDealRow(Number(params.id));
    if (!row || row.status !== 'active') throw new HttpError(404, 'Deal not found');
    if (row.submitted_by !== user.id) throw new HttpError(403, 'Only the person who posted this deal can edit its details');
    const d = await validateDealBody(db, body);
    // The form also carries the price, MRP and store of the poster's own store listing.
    const own = body.price !== undefined
      ? await db.get("SELECT * FROM offers WHERE deal_id = ? AND submitted_by = ? AND status = 'active' ORDER BY created_at LIMIT 1", row.id, user.id)
      : null;
    const offer = own ? validateOfferBody({ ...body, store: body.store ?? own.store, note: body.note ?? own.note }) : null;
    await blocklist.assertAllowed(d.title, d.details, offer?.store, offer?.note);
    await tx(db, async () => {
      await db.run(
        'UPDATE deals SET title = ?, image_url = ?, category_id = ?, details = ?, gtin = COALESCE(?, gtin), mpn = COALESCE(?, mpn), updated_at = ? WHERE id = ?',
        d.title, d.imageUrl, d.categoryId, d.details, d.gtin, d.mpn, Date.now(), row.id,
      );
      if (offer) {
        await db.run(
          'UPDATE offers SET price_cents = ?, full_price_cents = ?, store = ?, note = ?, updated_at = ? WHERE id = ?',
          offer.price, offer.fullPrice, offer.store, offer.note, Date.now(), own.id,
        );
        await repo.refreshDealPricing(row.id);
      }
    });
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

  route('GET', '/api/deals/:id/comments', async ({ params, user }) => {
    const rows = await db.all(
      `SELECT c.id, c.body, c.created_at, u.id AS user_id, u.handle, u.role FROM comments c JOIN users u ON u.id = c.user_id
        WHERE c.deal_id = ? AND c.status = 'visible'
          AND NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE ub.blocker_id = ? AND ub.blocked_id = c.user_id)
        ORDER BY c.created_at ASC LIMIT 500`,
      Number(params.id), user?.id ?? 0,
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
