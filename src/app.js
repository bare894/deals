import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { tx, slugify } from './db.js';
import { canonicalizeUrl, hashUrl, parseDealUrl } from './canonicalize.js';
import { autoPopulate, resolveShortener } from './scrape.js';
import { rankHot, rankForYou, categoryAffinity, HOT_WINDOW_MS } from './ranking.js';
import {
  SESSION_COOKIE, createSession, destroySession, hashPassword, parseCookies, sessionCookie, userForToken, verifyPassword,
} from './auth.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const RATE_LIMITS = {
  register: [5, HOUR],
  login: [20, 15 * MIN],
  submit: [10, HOUR],
  scrape: [40, 10 * MIN],
  vote: [120, 10 * MIN],
  comment: [20, 10 * MIN],
  report: [20, HOUR],
};
const REPORT_REASONS = ['spam', 'expired', 'wrong_price', 'duplicate', 'offensive', 'other'];
const ROLE_RANK = { user: 0, moderator: 1, admin: 2 };

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' https: http: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};

// ---------------------------------------------------------------- helpers

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const cents = (c) => (c == null ? null : c / 100);

function toCents(v, field, { required = false } = {}) {
  if (v === '' || v == null) {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw new HttpError(400, `${field} must be a valid amount`);
  return Math.round(n * 100);
}

function str(v, field, { min = 0, max, required = false } = {}) {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  if (required && !s) throw new HttpError(400, `${field} is required`);
  if (s.length < min) throw new HttpError(400, `${field} must be at least ${min} characters`);
  if (max && s.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return s;
}

function intParam(v, def, { min = 1, max = Infinity } = {}) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

function isUniqueViolation(err) {
  return /UNIQUE constraint failed/i.test(String(err?.message));
}

function makeRateLimiter() {
  const hits = new Map();
  return (key, [limit, windowMs]) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 50_000) hits.clear(); // crude memory cap for a single-process server
    return true;
  };
}

function placeholderSvg(text, hue) {
  const label = escapeHtml(String(text || 'Deal').slice(0, 24));
  const h = Number.isFinite(hue) ? hue : 210;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="450" viewBox="0 0 600 450">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},70%,62%)"/><stop offset="1" stop-color="hsl(${(h + 40) % 360},70%,45%)"/></linearGradient></defs>
<rect width="600" height="450" fill="url(#g)"/>
<text x="300" y="240" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif" font-size="44" font-weight="700" fill="#fff" text-anchor="middle">${label}</text></svg>`;
}

// ---------------------------------------------------------------- app

export function createApp({
  db,
  publicDir,
  scraper = autoPopulate,
  resolveUrl = resolveShortener,
  rateLimits = true,
  secureCookies = false,
  publicUrl = process.env.PUBLIC_URL,
}) {
  const routes = [];
  const limiter = makeRateLimiter();

  function route(method, pattern, opts, handler) {
    if (typeof opts === 'function') [handler, opts] = [opts, {}];
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, re, keys, opts, handler });
  }

  function rateLimit(name, key) {
    if (rateLimits && !limiter(`${name}:${key}`, RATE_LIMITS[name])) {
      throw new HttpError(429, "You're doing that too often — please wait a bit and try again.");
    }
  }

  function logAction(actorId, targetType, targetId, action, reason = null) {
    db.prepare('INSERT INTO moderation_actions (actor_id, target_type, target_id, action, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      actorId, targetType, targetId, action, reason || null, Date.now(),
    );
  }

  // -------------------------------------------------------------- deal queries

  const DEAL_SELECT = `
    SELECT d.*, c.name AS category_name, c.slug AS category_slug, u.handle AS poster_handle,
           (SELECT COUNT(*) FROM comments cm WHERE cm.deal_id = d.id AND cm.status = 'visible') AS comment_count
      FROM deals d
      LEFT JOIN categories c ON c.id = d.category_id
      JOIN users u ON u.id = d.submitted_by`;

  function serializeDeal(row, { full = false } = {}) {
    const fullPrice = cents(row.full_price_cents);
    const price = cents(row.price_cents);
    const deal = {
      id: row.id,
      title: row.title,
      imageUrl: row.image_url || null,
      category: row.category_id ? { id: row.category_id, name: row.category_name, slug: row.category_slug } : null,
      fullPrice,
      price,
      discountPct: fullPrice && price != null && fullPrice > price ? Math.round((1 - price / fullPrice) * 100) : null,
      store: row.store,
      score: row.score,
      upvotes: row.upvotes,
      downvotes: row.downvotes,
      commentCount: row.comment_count ?? 0,
      status: row.status,
      createdAt: row.created_at,
      poster: { id: row.submitted_by, handle: row.poster_handle },
    };
    if (full) Object.assign(deal, { details: row.details, sourceUrl: row.source_url, updatedAt: row.updated_at });
    return deal;
  }

  function attachMyVotes(deals, user) {
    if (!user || !deals.length) return deals;
    const ids = deals.map((d) => d.id);
    const rows = db.prepare(`SELECT deal_id, value FROM votes WHERE user_id = ? AND deal_id IN (${ids.map(() => '?').join(',')})`).all(user.id, ...ids);
    const map = new Map(rows.map((r) => [r.deal_id, r.value]));
    for (const d of deals) d.myVote = map.get(d.id) || 0;
    return deals;
  }

  function getDealRow(id) {
    return db.prepare(`${DEAL_SELECT} WHERE d.id = ?`).get(id);
  }

  function findActiveDuplicate(hash, excludeId = 0) {
    return db.prepare("SELECT id, title FROM deals WHERE canonical_url_hash = ? AND status = 'active' AND id != ?").get(hash, excludeId);
  }

  async function canonical(rawUrl) {
    let url;
    try {
      url = parseDealUrl(rawUrl);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    const resolved = await resolveUrl(url);
    const canonicalUrl = canonicalizeUrl(resolved);
    return { url, resolved, canonicalUrl, hash: hashUrl(canonicalUrl) };
  }

  function duplicateError(dup) {
    return new HttpError(409, 'This deal has already been posted', { duplicate: { id: dup.id, title: dup.title } });
  }

  function validateDealBody(body) {
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
    const price = toCents(body.price, 'Deal price', { required: true });
    const fullPrice = toCents(body.fullPrice, 'Full price');
    if (fullPrice != null && fullPrice < price) throw new HttpError(400, 'Full price should be higher than the deal price');
    return {
      title: str(body.title, 'Title', { required: true, min: 3, max: 200 }),
      imageUrl: imageUrl || null,
      categoryId,
      price,
      fullPrice,
      store: str(body.store, 'Store', { required: true, max: 80 }),
      details: str(body.details, 'Details', { max: 5000 }),
    };
  }

  function listDeals({ sort = 'new', categorySlug, q, page = 1, limit = 20, user }) {
    const where = ["d.status = 'active'"];
    const params = [];
    if (categorySlug) {
      where.push('c.slug = ?');
      params.push(categorySlug);
    }
    if (q) {
      const like = `%${escapeLike(q)}%`;
      where.push("(d.title LIKE ? ESCAPE '\\' OR d.store LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    const offset = (page - 1) * limit;
    let rows;
    if (sort === 'hot') {
      const all = db.prepare(`${DEAL_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC LIMIT 2000`).all(...params);
      rows = rankHot(all).slice(offset, offset + limit + 1);
    } else {
      rows = db.prepare(`${DEAL_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC, d.id DESC LIMIT ? OFFSET ?`).all(...params, limit + 1, offset);
    }
    const items = rows.slice(0, limit).map((r) => serializeDeal(r));
    return { items: attachMyVotes(items, user), page, hasMore: rows.length > limit };
  }

  function forYou(user, limit) {
    const windowStart = Date.now() - HOT_WINDOW_MS;
    if (!user) return { personalized: false, items: hotSlice(limit, windowStart) };
    const signals = db
      .prepare(
        `SELECT d.category_id, 'upvote' AS kind, COUNT(*) AS n FROM votes v JOIN deals d ON d.id = v.deal_id WHERE v.user_id = ? AND v.value = 1 GROUP BY d.category_id
         UNION ALL SELECT d.category_id, 'downvote', COUNT(*) FROM votes v JOIN deals d ON d.id = v.deal_id WHERE v.user_id = ? AND v.value = -1 GROUP BY d.category_id
         UNION ALL SELECT d.category_id, 'bookmark', COUNT(*) FROM bookmarks b JOIN deals d ON d.id = b.deal_id WHERE b.user_id = ? GROUP BY d.category_id
         UNION ALL SELECT d.category_id, 'comment', COUNT(*) FROM comments c JOIN deals d ON d.id = c.deal_id WHERE c.user_id = ? GROUP BY d.category_id
         UNION ALL SELECT d.category_id, 'view', COUNT(*) FROM views w JOIN deals d ON d.id = w.deal_id WHERE w.user_id = ? GROUP BY d.category_id`,
      )
      .all(user.id, user.id, user.id, user.id, user.id);
    const affinity = categoryAffinity(signals);
    if (![...affinity.values()].some((v) => v > 0)) return { personalized: false, items: hotSlice(limit, windowStart) };
    const candidates = db
      .prepare(
        `${DEAL_SELECT}
          WHERE d.status = 'active' AND d.created_at > ? AND d.submitted_by != ?
            AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.deal_id = d.id AND v.user_id = ?)
            AND NOT EXISTS (SELECT 1 FROM bookmarks b WHERE b.deal_id = d.id AND b.user_id = ?)
          ORDER BY d.created_at DESC LIMIT 1000`,
      )
      .all(windowStart, user.id, user.id, user.id);
    return { personalized: true, items: rankForYou(candidates, affinity).slice(0, limit).map((r) => serializeDeal(r)) };
  }

  function hotSlice(limit, windowStart) {
    const rows = db.prepare(`${DEAL_SELECT} WHERE d.status = 'active' AND d.created_at > ? AND d.score > 0 ORDER BY d.created_at DESC LIMIT 2000`).all(windowStart);
    return rankHot(rows).slice(0, limit).map((r) => serializeDeal(r));
  }

  // -------------------------------------------------------------- meta & auth

  function publicUser(u) {
    return u ? { id: u.id, handle: u.handle, email: u.email, role: u.role, status: u.status } : null;
  }

  route('GET', '/api/meta', ({ user }) => ({
    user: publicUser(user),
    categories: db.prepare('SELECT id, name, slug FROM categories WHERE active = 1 ORDER BY name = \'Other\', name').all().map((c) => ({ ...c })),
  }));

  route('POST', '/api/auth/register', ({ body, ip, setCookie }) => {
    rateLimit('register', ip);
    const email = str(body.email, 'Email', { required: true, max: 200 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Please enter a valid email');
    const handle = str(body.handle, 'Username', { required: true, min: 3, max: 24 });
    if (!/^[A-Za-z0-9_]+$/.test(handle)) throw new HttpError(400, 'Username may only contain letters, numbers, and underscores');
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    let id;
    try {
      id = Number(
        db.prepare('INSERT INTO users (email, handle, password_hash, created_at) VALUES (?, ?, ?, ?)').run(email, handle, hashPassword(password), Date.now())
          .lastInsertRowid,
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, /email/.test(err.message) ? 'An account with that email already exists' : 'That username is taken');
      throw err;
    }
    const { token, maxAge } = createSession(db, id);
    setCookie(sessionCookie(token, maxAge, secureCookies));
    return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) };
  });

  route('POST', '/api/auth/login', ({ body, ip, setCookie }) => {
    rateLimit('login', ip);
    const login = str(body.login, 'Email or username', { required: true });
    const row = db.prepare('SELECT * FROM users WHERE email = ? OR handle = ?').get(login, login);
    if (!row || !verifyPassword(String(body.password || ''), row.password_hash)) throw new HttpError(401, 'Incorrect email/username or password');
    if (row.status === 'banned') throw new HttpError(403, 'This account has been banned');
    const { token, maxAge } = createSession(db, row.id);
    setCookie(sessionCookie(token, maxAge, secureCookies));
    return { user: publicUser(row) };
  });

  route('POST', '/api/auth/logout', ({ token, setCookie }) => {
    destroySession(db, token);
    setCookie(sessionCookie('', 0, secureCookies));
    return { ok: true };
  });

  // -------------------------------------------------------------- discovery

  route('GET', '/api/home', ({ user }) => {
    const latest = db.prepare(`${DEAL_SELECT} WHERE d.status = 'active' ORDER BY d.created_at DESC LIMIT 12`).all().map((r) => serializeDeal(r));
    const hot = hotSlice(12, Date.now() - HOT_WINDOW_MS);
    const fy = forYou(user, 12);
    for (const list of [latest, hot, fy.items]) attachMyVotes(list, user);
    return { latest, hot, forYou: fy.items, forYouPersonalized: fy.personalized };
  });

  route('GET', '/api/deals', ({ query, user }) => {
    const sort = query.get('sort') === 'hot' ? 'hot' : 'new';
    return listDeals({
      sort,
      categorySlug: query.get('category') || null,
      q: (query.get('q') || '').trim().slice(0, 100) || null,
      page: intParam(query.get('page'), 1, { max: 500 }),
      limit: intParam(query.get('limit'), 20, { max: 50 }),
      user,
    });
  });

  route('GET', '/api/deals/:id', ({ params, user }) => {
    const row = getDealRow(Number(params.id));
    const isMod = user && ROLE_RANK[user.role] >= ROLE_RANK.moderator;
    if (!row || (row.status !== 'active' && !isMod)) throw new HttpError(404, 'This deal is no longer available');
    const deal = serializeDeal(row, { full: true });
    deal.myVote = 0;
    deal.bookmarked = false;
    deal.canEdit = Boolean(user && user.id === row.submitted_by && row.status === 'active');
    if (user) {
      deal.myVote = db.prepare('SELECT value FROM votes WHERE deal_id = ? AND user_id = ?').get(row.id, user.id)?.value || 0;
      deal.bookmarked = Boolean(db.prepare('SELECT 1 FROM bookmarks WHERE deal_id = ? AND user_id = ?').get(row.id, user.id));
      db.prepare('INSERT INTO views (user_id, deal_id, viewed_at) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET viewed_at = excluded.viewed_at').run(
        user.id, row.id, Date.now(),
      );
    }
    return { deal };
  });

  // -------------------------------------------------------------- submission (§9, §10)

  route('POST', '/api/deals/prefill', { auth: true, active: true }, async ({ body, user }) => {
    rateLimit('scrape', user.id);
    const { url, resolved, hash } = await canonical(body.url);
    const dup = findActiveDuplicate(hash);
    if (dup) throw duplicateError(dup);
    const result = await scraper(resolved.href);
    return { ok: result.ok, reason: result.reason, fields: result.fields, url: url.href };
  });

  route('POST', '/api/deals', { auth: true, active: true }, async ({ body, user }) => {
    rateLimit('submit', user.id);
    const { url, canonicalUrl, hash } = await canonical(body.url);
    const f = validateDealBody(body);
    const dup = findActiveDuplicate(hash);
    if (dup) throw duplicateError(dup);
    const now = Date.now();
    try {
      const id = Number(
        db
          .prepare(
            `INSERT INTO deals (submitted_by, title, image_url, category_id, full_price_cents, price_cents, store, source_url,
                                canonical_url, canonical_url_hash, details, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(user.id, f.title, f.imageUrl, f.categoryId, f.fullPrice, f.price, f.store, url.href, canonicalUrl, hash, f.details, now, now).lastInsertRowid,
      );
      return { deal: serializeDeal(getDealRow(id), { full: true }) };
    } catch (err) {
      // Two simultaneous submits of the same URL: the unique index catches the loser.
      if (isUniqueViolation(err)) throw duplicateError(findActiveDuplicate(hash) || { id: null, title: '' });
      throw err;
    }
  });

  route('PATCH', '/api/deals/:id', { auth: true, active: true }, async ({ params, body, user }) => {
    const row = getDealRow(Number(params.id));
    if (!row || row.status !== 'active') throw new HttpError(404, 'Deal not found');
    if (row.submitted_by !== user.id) throw new HttpError(403, 'You can only edit your own deals');
    const f = validateDealBody(body);
    let { source_url: sourceUrl, canonical_url: canonicalUrl, canonical_url_hash: hash } = row;
    if (body.url && body.url !== row.source_url) {
      const c = await canonical(body.url);
      const dup = findActiveDuplicate(c.hash, row.id);
      if (dup) throw duplicateError(dup);
      ({ canonicalUrl, hash } = c);
      sourceUrl = c.url.href;
    }
    try {
      db.prepare(
        `UPDATE deals SET title = ?, image_url = ?, category_id = ?, full_price_cents = ?, price_cents = ?, store = ?, details = ?,
                          source_url = ?, canonical_url = ?, canonical_url_hash = ?, updated_at = ? WHERE id = ?`,
      ).run(f.title, f.imageUrl, f.categoryId, f.fullPrice, f.price, f.store, f.details, sourceUrl, canonicalUrl, hash, Date.now(), row.id);
    } catch (err) {
      if (isUniqueViolation(err)) throw duplicateError(findActiveDuplicate(hash, row.id) || { id: null, title: '' });
      throw err;
    }
    return { deal: serializeDeal(getDealRow(row.id), { full: true }) };
  });

  // -------------------------------------------------------------- voting (§11)

  route('POST', '/api/deals/:id/vote', { auth: true, active: true }, ({ params, body, user }) => {
    rateLimit('vote', user.id);
    const value = Number(body.value);
    if (![1, -1, 0].includes(value)) throw new HttpError(400, 'Vote must be 1, -1, or 0');
    const dealId = Number(params.id);
    return tx(db, () => {
      const deal = db.prepare('SELECT id, submitted_by, status FROM deals WHERE id = ?').get(dealId);
      if (!deal || deal.status !== 'active') throw new HttpError(404, 'Deal not found');
      // Self-votes excluded to reduce gaming (PRD §11 recommendation, Open Q #6).
      if (deal.submitted_by === user.id) throw new HttpError(403, "You can't vote on your own deal");
      const prev = db.prepare('SELECT value FROM votes WHERE deal_id = ? AND user_id = ?').get(dealId, user.id)?.value || 0;
      if (prev !== value) {
        if (value === 0) db.prepare('DELETE FROM votes WHERE deal_id = ? AND user_id = ?').run(dealId, user.id);
        else
          db.prepare('INSERT INTO votes (deal_id, user_id, value, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (deal_id, user_id) DO UPDATE SET value = excluded.value').run(
            dealId, user.id, value, Date.now(),
          );
        const up = (value === 1 ? 1 : 0) - (prev === 1 ? 1 : 0);
        const down = (value === -1 ? 1 : 0) - (prev === -1 ? 1 : 0);
        db.prepare('UPDATE deals SET upvotes = upvotes + ?, downvotes = downvotes + ?, score = score + ? WHERE id = ?').run(up, down, up - down, dealId);
      }
      const d = db.prepare('SELECT upvotes, downvotes, score FROM deals WHERE id = ?').get(dealId);
      return { myVote: value, score: d.score, upvotes: d.upvotes, downvotes: d.downvotes };
    });
  });

  // -------------------------------------------------------------- comments (§12)

  route('GET', '/api/deals/:id/comments', ({ params }) => {
    const rows = db
      .prepare(
        `SELECT c.id, c.body, c.created_at, u.id AS user_id, u.handle, u.role FROM comments c JOIN users u ON u.id = c.user_id
          WHERE c.deal_id = ? AND c.status = 'visible' ORDER BY c.created_at ASC LIMIT 500`,
      )
      .all(Number(params.id));
    return { comments: rows.map((r) => ({ id: r.id, body: r.body, createdAt: r.created_at, author: { id: r.user_id, handle: r.handle, role: r.role } })) };
  });

  route('POST', '/api/deals/:id/comments', { auth: true, active: true }, ({ params, body, user }) => {
    rateLimit('comment', user.id);
    const text = str(body.body, 'Comment', { required: true, max: 2000 });
    const deal = db.prepare('SELECT status FROM deals WHERE id = ?').get(Number(params.id));
    if (!deal || deal.status !== 'active') throw new HttpError(404, 'Deal not found');
    const now = Date.now();
    const id = Number(db.prepare('INSERT INTO comments (deal_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(Number(params.id), user.id, text, now).lastInsertRowid);
    return { comment: { id, body: text, createdAt: now, author: { id: user.id, handle: user.handle, role: user.role } } };
  });

  // -------------------------------------------------------------- reports (user-facing flagging)

  function report(targetType, targetId, user, body) {
    rateLimit('report', user.id);
    const reason = String(body.reason || '');
    if (!REPORT_REASONS.includes(reason)) throw new HttpError(400, 'Please choose a reason');
    const note = str(body.note, 'Note', { max: 300 });
    const table = targetType === 'deal' ? 'deals' : 'comments';
    const okStatus = targetType === 'deal' ? 'active' : 'visible';
    const target = db.prepare(`SELECT status FROM ${table} WHERE id = ?`).get(targetId);
    if (!target || target.status !== okStatus) throw new HttpError(404, 'Not found');
    db.prepare(
      `INSERT INTO reports (reporter_id, target_type, target_id, reason, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (reporter_id, target_type, target_id) DO UPDATE SET reason = excluded.reason, status = 'open', created_at = excluded.created_at`,
    ).run(user.id, targetType, targetId, note ? `${reason}: ${note}` : reason, Date.now());
    return { ok: true };
  }
  route('POST', '/api/deals/:id/report', { auth: true }, ({ params, body, user }) => report('deal', Number(params.id), user, body));
  route('POST', '/api/comments/:id/report', { auth: true }, ({ params, body, user }) => report('comment', Number(params.id), user, body));

  // -------------------------------------------------------------- bookmarks (§13) & profile

  route('PUT', '/api/deals/:id/bookmark', { auth: true }, ({ params, user }) => {
    const deal = db.prepare('SELECT status FROM deals WHERE id = ?').get(Number(params.id));
    if (!deal || deal.status !== 'active') throw new HttpError(404, 'Deal not found');
    db.prepare('INSERT OR IGNORE INTO bookmarks (user_id, deal_id, created_at) VALUES (?, ?, ?)').run(user.id, Number(params.id), Date.now());
    return { bookmarked: true };
  });

  route('DELETE', '/api/deals/:id/bookmark', { auth: true }, ({ params, user }) => {
    db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND deal_id = ?').run(user.id, Number(params.id));
    return { bookmarked: false };
  });

  route('GET', '/api/me/bookmarks', { auth: true }, ({ user }) => {
    // Removed deals stay in the wishlist with a "No longer available" state (§13).
    const rows = db.prepare(`${DEAL_SELECT} JOIN bookmarks b ON b.deal_id = d.id AND b.user_id = ? ORDER BY b.created_at DESC`).all(user.id);
    return { items: attachMyVotes(rows.map((r) => serializeDeal(r)), user) };
  });

  route('GET', '/api/me/deals', { auth: true }, ({ user }) => {
    const rows = db.prepare(`${DEAL_SELECT} WHERE d.submitted_by = ? ORDER BY d.created_at DESC LIMIT 200`).all(user.id);
    return { items: rows.map((r) => serializeDeal(r)) };
  });

  // ============================================================== Admin Mode (§15)
  const MOD = { auth: true, role: 'moderator' };
  const ADMIN = { auth: true, role: 'admin' };

  function resolveReports(targetType, targetId, actorId, status = 'resolved') {
    return db
      .prepare("UPDATE reports SET status = ?, resolved_by = ?, resolved_at = ? WHERE target_type = ? AND target_id = ? AND status = 'open'")
      .run(status, actorId, Date.now(), targetType, targetId).changes;
  }

  route('GET', '/api/admin/summary', MOD, () => ({
    openReports: db.prepare("SELECT COUNT(DISTINCT target_type || ':' || target_id) AS n FROM reports WHERE status = 'open'").get().n,
    activeDeals: db.prepare("SELECT COUNT(*) AS n FROM deals WHERE status = 'active'").get().n,
    dealsToday: db.prepare('SELECT COUNT(*) AS n FROM deals WHERE created_at > ?').get(Date.now() - 24 * HOUR).n,
    users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
  }));

  route('GET', '/api/admin/reports', MOD, () => {
    const groups = db
      .prepare(
        `SELECT target_type, target_id, COUNT(*) AS n, GROUP_CONCAT(reason, ' | ') AS reasons, MAX(created_at) AS last_at
           FROM reports WHERE status = 'open' GROUP BY target_type, target_id ORDER BY n DESC, last_at DESC LIMIT 200`,
      )
      .all();
    const items = groups.map((g) => {
      const item = { targetType: g.target_type, targetId: g.target_id, count: g.n, reasons: String(g.reasons).split(' | '), lastAt: g.last_at };
      if (g.target_type === 'deal') {
        const d = getDealRow(g.target_id);
        item.deal = d ? serializeDeal(d) : null;
      } else {
        const c = db
          .prepare('SELECT c.id, c.body, c.status, c.deal_id, u.handle FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?')
          .get(g.target_id);
        item.comment = c ? { id: c.id, body: c.body, status: c.status, dealId: c.deal_id, author: c.handle } : null;
      }
      return item;
    });
    return { items };
  });

  route('POST', '/api/admin/reports/dismiss', MOD, ({ body, user }) => {
    const targetType = body.targetType === 'comment' ? 'comment' : 'deal';
    const targetId = Number(body.targetId);
    const n = resolveReports(targetType, targetId, user.id, 'dismissed');
    if (n) logAction(user.id, targetType, targetId, 'dismiss_reports', str(body.reason, 'Reason', { max: 300 }));
    return { dismissed: n };
  });

  route('GET', '/api/admin/deals', MOD, ({ query }) => {
    const status = ['active', 'removed'].includes(query.get('status')) ? query.get('status') : null;
    const q = (query.get('q') || '').trim();
    const page = intParam(query.get('page'), 1, { max: 1000 });
    const where = ['1 = 1'];
    const params = [];
    if (status) where.push('d.status = ?'), params.push(status);
    if (q) {
      const like = `%${escapeLike(q)}%`;
      where.push("(d.title LIKE ? ESCAPE '\\' OR d.store LIKE ? ESCAPE '\\' OR u.handle LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }
    const rows = db.prepare(`${DEAL_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC LIMIT 51 OFFSET ?`).all(...params, (page - 1) * 50);
    return { items: rows.slice(0, 50).map((r) => serializeDeal(r)), page, hasMore: rows.length > 50 };
  });

  route('POST', '/api/admin/deals/:id/remove', MOD, ({ params, body, user }) => {
    const reason = str(body.reason, 'Reason', { required: true, max: 300 });
    const id = Number(params.id);
    return tx(db, () => {
      const r = db.prepare("UPDATE deals SET status = 'removed', removed_at = ?, removed_by = ? WHERE id = ? AND status = 'active'").run(Date.now(), user.id, id);
      if (!r.changes) throw new HttpError(404, 'Deal not found or already removed');
      resolveReports('deal', id, user.id);
      logAction(user.id, 'deal', id, 'remove', reason);
      return { ok: true };
    });
  });

  route('POST', '/api/admin/deals/:id/restore', MOD, ({ params, body, user }) => {
    const id = Number(params.id);
    const row = db.prepare('SELECT canonical_url_hash, status FROM deals WHERE id = ?').get(id);
    if (!row || row.status !== 'removed') throw new HttpError(404, 'Deal not found or not removed');
    const dup = findActiveDuplicate(row.canonical_url_hash, id);
    if (dup) throw new HttpError(409, `Can't restore: the same URL was re-posted as deal #${dup.id}`, { duplicate: dup });
    try {
      tx(db, () => {
        db.prepare("UPDATE deals SET status = 'active', removed_at = NULL, removed_by = NULL WHERE id = ?").run(id);
        logAction(user.id, 'deal', id, 'restore', str(body.reason, 'Reason', { max: 300 }));
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, "Can't restore: the same URL is already live");
      throw err;
    }
    return { ok: true };
  });

  route('GET', '/api/admin/comments', MOD, ({ query }) => {
    const status = ['visible', 'removed'].includes(query.get('status')) ? query.get('status') : null;
    const q = (query.get('q') || '').trim();
    const where = ['1 = 1'];
    const params = [];
    if (status) where.push('c.status = ?'), params.push(status);
    if (q) {
      const like = `%${escapeLike(q)}%`;
      where.push("(c.body LIKE ? ESCAPE '\\' OR u.handle LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    const rows = db
      .prepare(
        `SELECT c.id, c.body, c.status, c.created_at, c.deal_id, d.title AS deal_title, u.handle
           FROM comments c JOIN users u ON u.id = c.user_id JOIN deals d ON d.id = c.deal_id
          WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC LIMIT 100`,
      )
      .all(...params);
    return {
      items: rows.map((r) => ({ id: r.id, body: r.body, status: r.status, createdAt: r.created_at, dealId: r.deal_id, dealTitle: r.deal_title, author: r.handle })),
    };
  });

  route('POST', '/api/admin/comments/:id/remove', MOD, ({ params, body, user }) => {
    const id = Number(params.id);
    const reason = str(body.reason, 'Reason', { required: true, max: 300 });
    return tx(db, () => {
      const r = db.prepare("UPDATE comments SET status = 'removed' WHERE id = ? AND status = 'visible'").run(id);
      if (!r.changes) throw new HttpError(404, 'Comment not found or already removed');
      resolveReports('comment', id, user.id);
      logAction(user.id, 'comment', id, 'remove', reason);
      return { ok: true };
    });
  });

  route('POST', '/api/admin/comments/:id/restore', MOD, ({ params, body, user }) => {
    const id = Number(params.id);
    return tx(db, () => {
      const r = db.prepare("UPDATE comments SET status = 'visible' WHERE id = ? AND status = 'removed'").run(id);
      if (!r.changes) throw new HttpError(404, 'Comment not found or not removed');
      logAction(user.id, 'comment', id, 'restore', str(body.reason, 'Reason', { max: 300 }));
      return { ok: true };
    });
  });

  // User management: Admin-only (Open Q #7 resolved conservatively).
  route('GET', '/api/admin/users', ADMIN, ({ query }) => {
    const q = (query.get('q') || '').trim();
    const params = [];
    let where = '1 = 1';
    if (q) {
      const like = `%${escapeLike(q)}%`;
      where = "(u.handle LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')";
      params.push(like, like);
    }
    const rows = db
      .prepare(
        `SELECT u.id, u.email, u.handle, u.role, u.status, u.created_at,
                (SELECT COUNT(*) FROM deals d WHERE d.submitted_by = u.id) AS deal_count,
                (SELECT COUNT(*) FROM deals d WHERE d.submitted_by = u.id AND d.status = 'removed') AS removed_count,
                (SELECT COUNT(*) FROM comments c WHERE c.user_id = u.id) AS comment_count
           FROM users u WHERE ${where}
          ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END, u.created_at DESC LIMIT 200`,
      )
      .all(...params);
    return {
      items: rows.map((r) => ({
        id: r.id, email: r.email, handle: r.handle, role: r.role, status: r.status, createdAt: r.created_at,
        dealCount: r.deal_count, removedCount: r.removed_count, commentCount: r.comment_count,
      })),
    };
  });

  function manageableTarget(id, actor) {
    const target = db.prepare('SELECT id, role, status, handle FROM users WHERE id = ?').get(id);
    if (!target) throw new HttpError(404, 'User not found');
    if (target.id === actor.id) throw new HttpError(400, "You can't change your own account here");
    if (target.role === 'admin') throw new HttpError(403, 'Admins cannot be modified from Admin Mode');
    return target;
  }

  route('POST', '/api/admin/users/:id/status', ADMIN, ({ params, body, user }) => {
    const status = String(body.status);
    if (!['active', 'suspended', 'banned'].includes(status)) throw new HttpError(400, 'Invalid status');
    const reason = str(body.reason, 'Reason', { required: status !== 'active', max: 300 });
    const target = manageableTarget(Number(params.id), user);
    tx(db, () => {
      db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, target.id);
      if (status === 'banned') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
      logAction(user.id, 'user', target.id, status === 'active' ? 'reinstate' : status === 'banned' ? 'ban' : 'suspend', reason);
    });
    return { ok: true };
  });

  route('POST', '/api/admin/users/:id/role', ADMIN, ({ params, body, user }) => {
    const role = String(body.role);
    if (!['user', 'moderator'].includes(role)) throw new HttpError(400, 'Role must be user or moderator');
    const target = manageableTarget(Number(params.id), user);
    if (target.role === role) return { ok: true };
    tx(db, () => {
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, target.id);
      logAction(user.id, 'user', target.id, role === 'moderator' ? 'promote_moderator' : 'demote_user', str(body.reason, 'Reason', { max: 300 }));
    });
    return { ok: true };
  });

  route('GET', '/api/admin/categories', ADMIN, () => ({
    items: db
      .prepare("SELECT c.*, (SELECT COUNT(*) FROM deals d WHERE d.category_id = c.id AND d.status = 'active') AS deal_count FROM categories c ORDER BY c.name")
      .all()
      .map((c) => ({ id: c.id, name: c.name, slug: c.slug, active: Boolean(c.active), dealCount: c.deal_count })),
  }));

  route('POST', '/api/admin/categories', ADMIN, ({ body, user }) => {
    const name = str(body.name, 'Name', { required: true, max: 40 });
    try {
      const id = Number(db.prepare('INSERT INTO categories (name, slug) VALUES (?, ?)').run(name, slugify(name)).lastInsertRowid);
      logAction(user.id, 'category', id, 'create', name);
      return { id };
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'A category with that name already exists');
      throw err;
    }
  });

  route('PATCH', '/api/admin/categories/:id', ADMIN, ({ params, body, user }) => {
    const id = Number(params.id);
    const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    if (!cat) throw new HttpError(404, 'Category not found');
    const name = body.name != null ? str(body.name, 'Name', { required: true, max: 40 }) : cat.name;
    const active = body.active != null ? (body.active ? 1 : 0) : cat.active;
    try {
      db.prepare('UPDATE categories SET name = ?, slug = ?, active = ? WHERE id = ?').run(name, slugify(name), active, id);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'A category with that name already exists');
      throw err;
    }
    const action = name !== cat.name ? `rename (${cat.name} → ${name})` : active ? 'activate' : 'deactivate';
    logAction(user.id, 'category', id, action);
    return { ok: true };
  });

  // Audit log: Moderators see their own actions, Admins see everything (§15).
  route('GET', '/api/admin/audit', MOD, ({ user, query }) => {
    const page = intParam(query.get('page'), 1, { max: 1000 });
    const mine = user.role !== 'admin';
    const rows = db
      .prepare(
        `SELECT m.*, u.handle AS actor_handle FROM moderation_actions m JOIN users u ON u.id = m.actor_id
          ${mine ? 'WHERE m.actor_id = ?' : ''} ORDER BY m.created_at DESC, m.id DESC LIMIT 51 OFFSET ?`,
      )
      .all(...(mine ? [user.id] : []), (page - 1) * 50);
    const label = (r) => {
      if (r.target_type === 'deal') return db.prepare('SELECT title FROM deals WHERE id = ?').get(r.target_id)?.title;
      if (r.target_type === 'user') return db.prepare('SELECT handle FROM users WHERE id = ?').get(r.target_id)?.handle;
      if (r.target_type === 'comment') return db.prepare('SELECT body FROM comments WHERE id = ?').get(r.target_id)?.body?.slice(0, 80);
      return db.prepare('SELECT name FROM categories WHERE id = ?').get(r.target_id)?.name;
    };
    return {
      scope: mine ? 'own' : 'all',
      page,
      hasMore: rows.length > 50,
      items: rows.slice(0, 50).map((r) => ({
        id: r.id, actor: r.actor_handle, targetType: r.target_type, targetId: r.target_id, targetLabel: label(r) || null,
        action: r.action, reason: r.reason, createdAt: r.created_at,
      })),
    };
  });

  // ============================================================== HTTP plumbing

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 100_000) throw new HttpError(413, 'Request too large');
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return v && typeof v === 'object' ? v : {};
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
  }

  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      ...(isJson ? { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } : {}),
      ...headers,
    });
    res.end(isJson ? JSON.stringify(body) : body);
  }

  function baseUrl(req) {
    if (publicUrl) return publicUrl.replace(/\/$/, '');
    const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
    return `${proto}://${req.headers.host}`;
  }

  let indexCache = null;
  async function indexHtml() {
    if (!indexCache || process.env.NODE_ENV !== 'production') indexCache = await readFile(path.join(publicDir, 'index.html'), 'utf8');
    return indexCache;
  }

  // Server-rendered Open Graph tags so shared deal links unfurl in Slack/iMessage (§14).
  async function renderIndex(req, dealId) {
    let html = await indexHtml();
    let tags = '';
    if (dealId) {
      const row = getDealRow(dealId);
      if (row && row.status === 'active') {
        const d = serializeDeal(row);
        const price = d.price === 0 ? 'FREE' : `$${d.price?.toFixed(2)}`;
        const desc = [price, d.fullPrice ? `(was $${d.fullPrice.toFixed(2)}${d.discountPct ? `, ${d.discountPct}% off` : ''})` : '', `at ${d.store}`, `· ${d.score >= 0 ? '+' : ''}${d.score} votes`]
          .filter(Boolean)
          .join(' ');
        const url = `${baseUrl(req)}/deals/${d.id}`;
        const imagePath = d.imageUrl || `/img/placeholder.svg?t=${encodeURIComponent(d.store)}`;
        const image = imagePath.startsWith('/') ? `${baseUrl(req)}${imagePath}` : imagePath;
        tags = [
          ['og:type', 'product'], ['og:site_name', 'DealShare'], ['og:title', d.title], ['og:description', desc], ['og:url', url], ['og:image', image],
          ['product:price:amount', d.price?.toFixed(2)], ['product:price:currency', 'USD'],
        ]
          .map(([p, c]) => `<meta property="${p}" content="${escapeHtml(c)}">`)
          .concat([
            '<meta name="twitter:card" content="summary_large_image">',
            `<link rel="canonical" href="${escapeHtml(url)}">`,
            // Deep-link hint for the native apps (Phase 4); app ids are placeholders until the apps exist.
            `<meta property="al:web:url" content="${escapeHtml(url)}">`,
          ])
          .join('\n    ');
        html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(d.title)} — DealShare</title>`);
      }
    }
    return html.replace('<!--OG-->', tags);
  }

  async function serveStatic(req, res, pathname) {
    const file = path.normalize(path.join(publicDir, decodeURIComponent(pathname)));
    if (!file.startsWith(publicDir + path.sep)) return false;
    try {
      const s = await stat(file);
      if (!s.isFile()) return false;
      const body = await readFile(file);
      send(res, 200, body, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': process.env.NODE_ENV === 'production' ? 'public, max-age=3600' : 'no-cache',
      });
      return true;
    } catch {
      return false;
    }
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    try {
      if (pathname.startsWith('/api/')) {
        const method = req.method;
        let match = null;
        let methodMismatch = false;
        for (const r of routes) {
          const m = r.re.exec(pathname);
          if (!m) continue;
          if (r.method !== method) {
            methodMismatch = true;
            continue;
          }
          match = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
          break;
        }
        if (!match) throw new HttpError(methodMismatch ? 405 : 404, methodMismatch ? 'Method not allowed' : 'Not found');

        if (method !== 'GET' && method !== 'HEAD') {
          // CSRF defense: cross-site forms can't send JSON, and browsers always send Origin on cross-site POSTs.
          const origin = req.headers.origin;
          if (origin) {
            let originHost = null;
            try {
              originHost = new URL(origin).host;
            } catch {
              /* "null" or malformed origin */
            }
            if (originHost !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked');
          }
          if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Content-Type must be application/json');
        }

        const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        const user = userForToken(db, token);
        const { opts } = match.r;
        if (opts.auth && !user) throw new HttpError(401, 'Please sign in to continue');
        if (opts.role && ROLE_RANK[user.role] < ROLE_RANK[opts.role]) throw new HttpError(403, 'You do not have permission to do that');
        if ((opts.active || opts.role) && user.status !== 'active') throw new HttpError(403, 'Your account is suspended');

        const cookies = [];
        const body = method === 'GET' || method === 'HEAD' ? {} : await readJson(req);
        const result = await match.r.handler({
          req, params: match.params, query: url.searchParams, body, user, token,
          ip: req.socket.remoteAddress, setCookie: (c) => cookies.push(c),
        });
        return send(res, 200, result, cookies.length ? { 'set-cookie': cookies } : {});
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });

      if (pathname === '/img/placeholder.svg') {
        const t = url.searchParams.get('t') || 'Deal';
        const hue = Number(url.searchParams.get('h') ?? [...t].reduce((a, c) => a + c.charCodeAt(0), 0) % 360);
        return send(res, 200, placeholderSvg(t, hue), { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
      }

      if (pathname !== '/' && (await serveStatic(req, res, pathname))) return;

      // SPA fallback (history routing); deal pages get OG tags.
      const dealMatch = pathname.match(/^\/deals\/(\d+)$/);
      if (path.extname(pathname) && !dealMatch) return send(res, 404, 'Not found', { 'content-type': 'text/plain' });
      const html = await renderIndex(req, dealMatch ? Number(dealMatch[1]) : null);
      return send(res, 200, html, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...err.extra });
      console.error(err);
      return send(res, 500, { error: 'Something went wrong' });
    }
  };
}
