// Data access for deals (products) and offers (store listings). Routes stay thin; every
// multi-row invariant (best price cache, merge, remove/restore) lives here.
import { tx } from './db.js';
import { HttpError, cents, escapeLike, isUniqueViolation } from './http.js';
import { rankHot, rankForYou, categoryAffinity, HOT_WINDOW_MS } from './ranking.js';
import { productScore, productTokens, confidence, MIN_SUGGEST, HIGH_CONFIDENCE } from './matching.js';

const discount = (full, price) => (full && price != null && full > price ? Math.round((1 - price / full) * 100) : null);

export function createRepo(db) {
  const DEAL_SELECT = `
    SELECT d.*, c.name AS category_name, c.slug AS category_slug, u.handle AS poster_handle,
           (SELECT COUNT(*) FROM comments cm WHERE cm.deal_id = d.id AND cm.status = 'visible') AS comment_count
      FROM deals d
      LEFT JOIN categories c ON c.id = d.category_id
      JOIN users u ON u.id = d.submitted_by`;

  const OFFER_SELECT = 'SELECT o.*, u.handle AS poster_handle FROM offers o JOIN users u ON u.id = o.submitted_by';

  // ------------------------------------------------------------ serialization

  function serializeOffer(o) {
    const price = cents(o.price_cents);
    const fullPrice = cents(o.full_price_cents);
    return {
      id: o.id,
      dealId: o.deal_id,
      store: o.store,
      storeKey: o.store_key,
      url: o.source_url,
      price,
      fullPrice,
      discountPct: discount(fullPrice, price),
      note: o.note,
      status: o.status,
      createdAt: o.created_at,
      updatedAt: o.updated_at,
      poster: { id: o.submitted_by, handle: o.poster_handle },
    };
  }

  function serializeDeal(row, { full = false, offers = null } = {}) {
    const price = cents(row.best_price_cents);
    const fullPrice = cents(row.best_full_price_cents);
    const deal = {
      id: row.id,
      title: row.title,
      imageUrl: row.image_url || null,
      category: row.category_id ? { id: row.category_id, name: row.category_name, slug: row.category_slug } : null,
      price,
      fullPrice,
      discountPct: discount(fullPrice, price),
      store: row.best_store,
      offerCount: row.offer_count,
      score: row.score,
      upvotes: row.upvotes,
      downvotes: row.downvotes,
      commentCount: row.comment_count ?? 0,
      status: row.status,
      createdAt: row.created_at,
      poster: { id: row.submitted_by, handle: row.poster_handle },
    };
    if (full) Object.assign(deal, { details: row.details, gtin: row.gtin, mpn: row.mpn, updatedAt: row.updated_at, mergedInto: row.merged_into });
    if (offers) deal.offers = offers.map(serializeOffer);
    return deal;
  }

  // ------------------------------------------------------------ reads

  const getDealRow = (id) => db.get(`${DEAL_SELECT} WHERE d.id = ?`, id);
  const getOfferRow = (id) => db.get(`${OFFER_SELECT} WHERE o.id = ?`, id);

  function dealOffers(dealId, { includeRemoved = false } = {}) {
    return db.all(
      `${OFFER_SELECT} WHERE o.deal_id = ? AND o.status ${includeRemoved ? "!= 'deal_removed'" : "= 'active'"} ORDER BY o.status = 'active' DESC, o.price_cents ASC, o.created_at ASC`,
      dealId,
    );
  }

  async function getDeal(id, { includeRemovedOffers = false } = {}) {
    const row = await getDealRow(id);
    if (!row) return null;
    const offers = await dealOffers(id, { includeRemoved: includeRemovedOffers || row.status !== 'active' });
    return serializeDeal(row, { full: true, offers });
  }

  /** Who already holds this exact product link? Used for "already posted" errors. */
  function findActiveOfferByHash(hash, excludeOfferId = 0) {
    return db.get(
      `SELECT o.id AS offer_id, o.deal_id, d.title FROM offers o JOIN deals d ON d.id = o.deal_id
        WHERE o.canonical_url_hash = ? AND o.status = 'active' AND o.id != ?`,
      hash, excludeOfferId,
    );
  }

  function storeOnDeal(dealId, storeKey, excludeOfferId = 0) {
    return db.get(`${OFFER_SELECT} WHERE o.deal_id = ? AND o.store_key = ? AND o.status = 'active' AND o.id != ?`, dealId, storeKey, excludeOfferId);
  }

  async function attachMyVotes(deals, user) {
    if (!user || !deals.length) return deals;
    const rows = await db.all('SELECT deal_id, value FROM votes WHERE user_id = ? AND deal_id = ANY(?::int[])', user.id, deals.map((d) => d.id));
    const map = new Map(rows.map((r) => [r.deal_id, r.value]));
    for (const d of deals) d.myVote = map.get(d.id) || 0;
    return deals;
  }

  async function listDeals({ sort = 'new', categorySlug, q, page = 1, limit = 20, user }) {
    const where = ["d.status = 'active'"];
    const params = [];
    if (categorySlug) {
      where.push('c.slug = ?');
      params.push(categorySlug);
    }
    if (q) {
      const like = `%${escapeLike(q)}%`;
      where.push("(d.title ILIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM offers o WHERE o.deal_id = d.id AND o.status = 'active' AND o.store ILIKE ? ESCAPE '\\'))");
      params.push(like, like);
    }
    const offset = (page - 1) * limit;
    let rows;
    if (sort === 'hot') {
      const all = await db.all(`${DEAL_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC LIMIT 2000`, ...params);
      rows = rankHot(all).slice(offset, offset + limit + 1);
    } else {
      rows = await db.all(`${DEAL_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC, d.id DESC LIMIT ? OFFSET ?`, ...params, limit + 1, offset);
    }
    const items = rows.slice(0, limit).map((r) => serializeDeal(r));
    return { items: await attachMyVotes(items, user), page, hasMore: rows.length > limit };
  }

  async function latest(limit) {
    return (await db.all(`${DEAL_SELECT} WHERE d.status = 'active' ORDER BY d.created_at DESC LIMIT ?`, limit)).map((r) => serializeDeal(r));
  }

  async function hotSlice(limit) {
    const rows = await db.all(`${DEAL_SELECT} WHERE d.status = 'active' AND d.created_at > ? AND d.score > 0 ORDER BY d.created_at DESC LIMIT 2000`, Date.now() - HOT_WINDOW_MS);
    return rankHot(rows).slice(0, limit).map((r) => serializeDeal(r));
  }

  async function forYou(user, limit) {
    if (!user) return { personalized: false, items: await hotSlice(limit) };
    const signals = await db.all(
        `SELECT d.category_id, 'upvote' AS kind, COUNT(*) AS n FROM votes v JOIN deals d ON d.id = v.deal_id WHERE v.user_id = ? AND v.value = 1 GROUP BY d.category_id
         UNION ALL SELECT d.category_id, 'downvote', COUNT(*) FROM votes v JOIN deals d ON d.id = v.deal_id WHERE v.user_id = ? AND v.value = -1 GROUP BY d.category_id
         UNION ALL SELECT d.category_id, 'bookmark', COUNT(*) FROM bookmarks b JOIN deals d ON d.id = b.deal_id WHERE b.user_id = ? GROUP BY d.category_id
         UNION ALL SELECT d.category_id, 'comment', COUNT(*) FROM comments c JOIN deals d ON d.id = c.deal_id WHERE c.user_id = ? GROUP BY d.category_id
         UNION ALL SELECT d.category_id, 'view', COUNT(*) FROM views w JOIN deals d ON d.id = w.deal_id WHERE w.user_id = ? GROUP BY d.category_id`,
        user.id, user.id, user.id, user.id, user.id,
      );
    const affinity = categoryAffinity(signals);
    if (![...affinity.values()].some((v) => v > 0)) return { personalized: false, items: await hotSlice(limit) };
    const candidates = await db.all(
        `${DEAL_SELECT}
          WHERE d.status = 'active' AND d.created_at > ? AND d.submitted_by != ?
            AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.deal_id = d.id AND v.user_id = ?)
            AND NOT EXISTS (SELECT 1 FROM bookmarks b WHERE b.deal_id = d.id AND b.user_id = ?)
          ORDER BY d.created_at DESC LIMIT 1000`,
        Date.now() - HOT_WINDOW_MS, user.id, user.id, user.id,
      );
    return { personalized: true, items: rankForYou(candidates, affinity).slice(0, limit).map((r) => serializeDeal(r)) };
  }

  // ------------------------------------------------------------ product matching

  const MATCH_WINDOW_MS = 120 * 24 * 3_600_000;

  /**
   * Existing active deals that look like the same product (cross-store dedup).
   * `storeKey` flags matches that already list that store, so the UI can explain why the
   * user can't add their link there.
   */
  async function findMatches({ title, gtin, mpn }, { storeKey = null, excludeDealId = 0, limit = 3 } = {}) {
    if (!title && !gtin && !mpn) return [];
    const probe = { title, gtin, mpn, tokens: productTokens(title) };
    const rows = await db.all(
      `${DEAL_SELECT} WHERE d.status = 'active' AND d.id != ? AND (d.created_at > ? OR d.gtin = ?) ORDER BY d.created_at DESC LIMIT 3000`,
      excludeDealId, Date.now() - MATCH_WINDOW_MS, gtin || '',
    );
    const scored = [];
    for (const r of rows) {
      const score = productScore(probe, { title: r.title, gtin: r.gtin, mpn: r.mpn });
      if (score >= MIN_SUGGEST) scored.push({ r, score });
    }
    scored.sort((a, b) => b.score - a.score || b.r.score - a.r.score);
    const out = [];
    for (const { r, score } of scored.slice(0, limit)) {
      const existing = storeKey ? await storeOnDeal(r.id, storeKey) : null;
      out.push({
        deal: serializeDeal(r),
        score: Math.round(score * 100) / 100,
        confidence: confidence(score),
        storeListed: existing ? { store: existing.store, by: existing.poster_handle, price: cents(existing.price_cents) } : null,
      });
    }
    return out;
  }

  /** Pairs of live deals that are probably the same product — the moderators' merge queue. */
  async function duplicatePairs(limit = 50) {
    const rows = await db.all(`${DEAL_SELECT} WHERE d.status = 'active' ORDER BY d.created_at DESC LIMIT 800`);
    const items = rows.map((r) => ({ r, p: { title: r.title, gtin: r.gtin, mpn: r.mpn, tokens: productTokens(r.title) } }));
    const pairs = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const score = productScore(items[i].p, items[j].p);
        if (score >= HIGH_CONFIDENCE) {
          // Suggest merging the newer deal into the older one (the original post keeps its URL).
          const [older, newer] = items[i].r.created_at <= items[j].r.created_at ? [items[i].r, items[j].r] : [items[j].r, items[i].r];
          pairs.push({ score: Math.round(score * 100) / 100, keep: serializeDeal(older), merge: serializeDeal(newer) });
        }
      }
    }
    return pairs.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ------------------------------------------------------------ writes

  /** Recompute the cached cheapest-offer fields on a deal after any offer change. */
  async function refreshDealPricing(dealId) {
    const offers = await db.all(
      "SELECT price_cents, full_price_cents, store FROM offers WHERE deal_id = ? AND status = 'active' ORDER BY price_cents ASC, created_at ASC",
      dealId,
    );
    const best = offers[0];
    // MRP is printed on the product and the same everywhere in India, so if the cheapest
    // listing didn't state one, borrow the MRP another store listed.
    let mrp = best?.full_price_cents ?? null;
    if (best && mrp == null) mrp = Math.max(-1, ...offers.map((o) => o.full_price_cents ?? -1));
    if (best && (mrp == null || mrp <= best.price_cents)) mrp = null;
    await db.run(
      'UPDATE deals SET best_price_cents = ?, best_full_price_cents = ?, best_store = ?, offer_count = ? WHERE id = ?',
      best?.price_cents ?? null, mrp, best?.store ?? null, offers.length, dealId,
    );
  }

  async function insertOffer(dealId, userId, link, f) {
    const now = Date.now();
    try {
      // Savepoint: a unique violation must not abort the caller's transaction, so we can explain it.
      const { id } = await db.savepoint(() =>
        db.get(
          `INSERT INTO offers (deal_id, submitted_by, store, store_key, source_url, canonical_url, canonical_url_hash, price_cents, full_price_cents, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          dealId, userId, f.store, link.storeKey, link.url.href, link.canonicalUrl, link.hash, f.price, f.fullPrice, f.note, now, now,
        ),
      );
      await refreshDealPricing(dealId);
      return id;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Lost a race with a concurrent submit: report which rule we hit.
      const dup = await findActiveOfferByHash(link.hash);
      if (dup) throw duplicateLinkError(dup);
      throw storeConflictError(await storeOnDeal(dealId, link.storeKey));
    }
  }

  function createDealWithOffer(userId, d, link, offer) {
    return tx(db, async () => {
      const now = Date.now();
      const { id: dealId } = await db.get(
        `INSERT INTO deals (submitted_by, title, image_url, category_id, details, gtin, mpn, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        userId, d.title, d.imageUrl, d.categoryId, d.details, d.gtin, d.mpn, now, now,
      );
      await insertOffer(dealId, userId, link, offer);
      return dealId;
    });
  }

  function addOffer(dealId, userId, link, offer, product = {}) {
    return tx(db, async () => {
      // Row lock: concurrent store additions to one deal take turns.
      const deal = await db.get('SELECT status, gtin, mpn FROM deals WHERE id = ? FOR UPDATE', dealId);
      if (!deal || deal.status !== 'active') throw new HttpError(404, 'Deal not found');
      const existing = await storeOnDeal(dealId, link.storeKey);
      if (existing) throw storeConflictError(existing);
      const id = await insertOffer(dealId, userId, link, offer);
      // Learn product identifiers from the new store page if the deal didn't have them yet.
      if ((!deal.gtin && product.gtin) || (!deal.mpn && product.mpn)) {
        await db.run('UPDATE deals SET gtin = COALESCE(gtin, ?), mpn = COALESCE(mpn, ?) WHERE id = ?', product.gtin || null, product.mpn || null, dealId);
      }
      return id;
    });
  }

  function setOfferStatus(offerId, status, actorId) {
    return tx(db, async () => {
      const o = await db.get('SELECT * FROM offers WHERE id = ?', offerId);
      if (!o) throw new HttpError(404, 'Offer not found');
      const deal = await db.get('SELECT status FROM deals WHERE id = ? FOR UPDATE', o.deal_id);
      if (status === 'removed') {
        if (o.status !== 'active') throw new HttpError(404, 'Offer not found or already removed');
        const { n } = await db.get("SELECT COUNT(*) AS n FROM offers WHERE deal_id = ? AND status = 'active'", o.deal_id);
        if (n <= 1) throw new HttpError(409, 'This is the only store on the deal — remove the whole deal instead.');
        await db.run("UPDATE offers SET status = 'removed', removed_at = ?, removed_by = ? WHERE id = ?", Date.now(), actorId, offerId);
      } else {
        if (o.status !== 'removed') throw new HttpError(404, 'Offer not found or not removed');
        if (deal.status !== 'active') throw new HttpError(409, 'Restore the deal first');
        if (await findActiveOfferByHash(o.canonical_url_hash)) throw new HttpError(409, 'That link has been posted again elsewhere');
        if (await storeOnDeal(o.deal_id, o.store_key)) throw new HttpError(409, `${o.store} is already listed on this deal again`);
        await db.run("UPDATE offers SET status = 'active', removed_at = NULL, removed_by = NULL WHERE id = ?", offerId);
      }
      await refreshDealPricing(o.deal_id);
      return o;
    });
  }

  async function removeDeal(dealId, actorId) {
    const r = await db.run("UPDATE deals SET status = 'removed', removed_at = ?, removed_by = ? WHERE id = ? AND status = 'active'", Date.now(), actorId, dealId);
    if (!r.changes) throw new HttpError(404, 'Deal not found or already removed');
    // Free the links so the products can be posted again (PRD Open Q #4).
    await db.run("UPDATE offers SET status = 'deal_removed' WHERE deal_id = ? AND status = 'active'", dealId);
    await refreshDealPricing(dealId);
  }

  async function restoreDeal(dealId) {
    const deal = await db.get('SELECT status, merged_into FROM deals WHERE id = ? FOR UPDATE', dealId);
    if (!deal || deal.status !== 'removed') throw new HttpError(404, 'Deal not found or not removed');
    if (deal.merged_into) throw new HttpError(409, `This deal was merged into #${deal.merged_into} and can't be restored`);
    await db.run("UPDATE deals SET status = 'active', removed_at = NULL, removed_by = NULL WHERE id = ?", dealId);
    let restored = 0;
    for (const o of await db.all("SELECT id FROM offers WHERE deal_id = ? AND status = 'deal_removed'", dealId)) {
      try {
        await db.savepoint(() => db.run("UPDATE offers SET status = 'active' WHERE id = ?", o.id));
        restored++;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // That link (or store) was re-posted while this deal was down; keep it retired.
        await db.run("UPDATE offers SET status = 'removed' WHERE id = ?", o.id);
      }
    }
    if (!restored) throw new HttpError(409, "Can't restore: every store link on this deal has been re-posted elsewhere");
    await refreshDealPricing(dealId);
    return restored;
  }

  /**
   * Fold `sourceId` into `targetId`: offers, votes, comments, bookmarks and views move over;
   * when both list the same store, the cheaper listing wins. The source becomes a removed
   * deal pointing at the target, so old links redirect.
   */
  async function mergeDeals(sourceId, targetId, actorId) {
    if (sourceId === targetId) throw new HttpError(400, "Can't merge a deal into itself");
    // Lock both deals in id order so two opposite merges can't deadlock.
    await db.all('SELECT id FROM deals WHERE id = ANY(?::int[]) ORDER BY id FOR UPDATE', [sourceId, targetId]);
    const src = await db.get('SELECT * FROM deals WHERE id = ?', sourceId);
    const dst = await db.get('SELECT * FROM deals WHERE id = ?', targetId);
    if (!src || src.status !== 'active') throw new HttpError(404, `Deal #${sourceId} not found or not active`);
    if (!dst || dst.status !== 'active') throw new HttpError(404, `Deal #${targetId} not found or not active`);
    const now = Date.now();

    let movedOffers = 0;
    for (const o of await db.all("SELECT * FROM offers WHERE deal_id = ? AND status = 'active'", sourceId)) {
      const clash = await db.get("SELECT * FROM offers WHERE deal_id = ? AND store_key = ? AND status = 'active'", targetId, o.store_key);
      if (clash && clash.price_cents <= o.price_cents) {
        await db.run("UPDATE offers SET status = 'removed', removed_at = ?, removed_by = ? WHERE id = ?", now, actorId, o.id);
        continue;
      }
      if (clash) await db.run("UPDATE offers SET status = 'removed', removed_at = ?, removed_by = ? WHERE id = ?", now, actorId, clash.id);
      await db.run('UPDATE offers SET deal_id = ? WHERE id = ?', targetId, o.id);
      movedOffers++;
    }

    // Votes: one per user per deal, and the target's creator can't vote on their own deal.
    let dropUp = 0;
    let dropDown = 0;
    for (const v of await db.all('SELECT * FROM votes WHERE deal_id = ?', sourceId)) {
      const conflict = v.user_id === dst.submitted_by || (await db.get('SELECT 1 FROM votes WHERE deal_id = ? AND user_id = ?', targetId, v.user_id));
      if (conflict) {
        await db.run('DELETE FROM votes WHERE id = ?', v.id);
        v.value === 1 ? dropUp++ : dropDown++;
      } else await db.run('UPDATE votes SET deal_id = ? WHERE id = ?', targetId, v.id);
    }
    const up = Math.max(0, src.upvotes - dropUp);
    const down = Math.max(0, src.downvotes - dropDown);
    await db.run(
      'UPDATE deals SET upvotes = upvotes + ?, downvotes = downvotes + ?, score = score + ?, gtin = COALESCE(gtin, ?), mpn = COALESCE(mpn, ?), updated_at = ? WHERE id = ?',
      up, down, up - down, src.gtin, src.mpn, now, targetId,
    );

    await db.run('UPDATE comments SET deal_id = ? WHERE deal_id = ?', targetId, sourceId);
    await db.run('INSERT INTO bookmarks (user_id, deal_id, created_at) SELECT user_id, ?::int, created_at FROM bookmarks WHERE deal_id = ? ON CONFLICT DO NOTHING', targetId, sourceId);
    await db.run('DELETE FROM bookmarks WHERE deal_id = ?', sourceId);
    await db.run('INSERT INTO views (user_id, deal_id, viewed_at) SELECT user_id, ?::int, viewed_at FROM views WHERE deal_id = ? ON CONFLICT DO NOTHING', targetId, sourceId);
    await db.run('DELETE FROM views WHERE deal_id = ?', sourceId);

    await db.run(
      "UPDATE deals SET status = 'removed', merged_into = ?, removed_at = ?, removed_by = ?, upvotes = 0, downvotes = 0, score = 0 WHERE id = ?",
      targetId, now, actorId, sourceId,
    );
    await db.run("UPDATE offers SET status = 'deal_removed' WHERE deal_id = ? AND status = 'active'", sourceId);
    await refreshDealPricing(sourceId);
    await refreshDealPricing(targetId);
    return { movedOffers };
  }

  // ------------------------------------------------------------ moderation bookkeeping

  async function logAction(actorId, targetType, targetId, action, reason = null) {
    await db.run(
      'INSERT INTO moderation_actions (actor_id, target_type, target_id, action, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      actorId, targetType, targetId, action, reason || null, Date.now(),
    );
  }

  async function resolveReports(targetType, targetId, actorId, status = 'resolved') {
    const r = await db.run(
      "UPDATE reports SET status = ?, resolved_by = ?, resolved_at = ? WHERE target_type = ? AND target_id = ? AND status = 'open'",
      status, actorId, Date.now(), targetType, targetId,
    );
    return r.changes;
  }

  return {
    DEAL_SELECT, serializeDeal, serializeOffer, getDealRow, getOfferRow, getDeal, dealOffers, findActiveOfferByHash, storeOnDeal,
    attachMyVotes, listDeals, latest, hotSlice, forYou, findMatches, duplicatePairs,
    refreshDealPricing, createDealWithOffer, addOffer, setOfferStatus, removeDeal, restoreDeal, mergeDeals, logAction, resolveReports,
  };
}

export function duplicateLinkError(dup) {
  return new HttpError(409, 'This link has already been posted', { duplicate: { id: dup.deal_id, title: dup.title } });
}

export function storeConflictError(existing) {
  return new HttpError(
    409,
    existing
      ? `${existing.store} is already listed on this deal by @${existing.poster_handle}. If the price changed, report that listing so it can be updated.`
      : 'That store is already listed on this deal',
    { storeConflict: true },
  );
}
