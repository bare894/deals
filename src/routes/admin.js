// Admin Mode (PRD §15). Every route is role-gated server-side by the router options.
import { tx, slugify } from '../db.js';
import { HttpError, cents, escapeLike, intParam, isUniqueViolation, str } from '../http.js';

const MOD = { auth: true, role: 'moderator' };
const ADMIN = { auth: true, role: 'admin' };
const DAY = 24 * 3_600_000;

export function registerAdminRoutes({ route, db, repo }) {
  route('GET', '/api/admin/summary', MOD, () => ({
    openReports: db.prepare("SELECT COUNT(DISTINCT target_type || ':' || target_id) AS n FROM reports WHERE status = 'open'").get().n,
    activeDeals: db.prepare("SELECT COUNT(*) AS n FROM deals WHERE status = 'active'").get().n,
    dealsToday: db.prepare('SELECT COUNT(*) AS n FROM deals WHERE created_at > ?').get(Date.now() - DAY).n,
    users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
  }));

  // ------------------------------------------------------------ report queue

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
        const d = repo.getDealRow(g.target_id);
        item.deal = d ? repo.serializeDeal(d) : null;
      } else if (g.target_type === 'offer') {
        const o = repo.getOfferRow(g.target_id);
        item.offer = o ? repo.serializeOffer(o) : null;
        const d = o && repo.getDealRow(o.deal_id);
        item.deal = d ? repo.serializeDeal(d) : null;
      } else {
        const c = db.prepare('SELECT c.id, c.body, c.status, c.deal_id, u.handle FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(g.target_id);
        item.comment = c ? { id: c.id, body: c.body, status: c.status, dealId: c.deal_id, author: c.handle } : null;
      }
      return item;
    });
    return { items };
  });

  route('POST', '/api/admin/reports/dismiss', MOD, ({ body, user }) => {
    const targetType = ['deal', 'comment', 'offer'].includes(body.targetType) ? body.targetType : 'deal';
    const targetId = Number(body.targetId);
    const n = repo.resolveReports(targetType, targetId, user.id, 'dismissed');
    if (n) repo.logAction(user.id, targetType, targetId, 'dismiss_reports', str(body.reason, 'Reason', { max: 300 }));
    return { dismissed: n };
  });

  // ------------------------------------------------------------ deals

  route('GET', '/api/admin/deals', MOD, ({ query }) => {
    const status = ['active', 'removed'].includes(query.get('status')) ? query.get('status') : null;
    const q = (query.get('q') || '').trim();
    const page = intParam(query.get('page'), 1, { max: 1000 });
    const where = ['1 = 1'];
    const params = [];
    if (status) where.push('d.status = ?'), params.push(status);
    if (q) {
      const like = `%${escapeLike(q)}%`;
      where.push("(d.title LIKE ? ESCAPE '\\' OR u.handle LIKE ? ESCAPE '\\' OR CAST(d.id AS TEXT) = ?)");
      params.push(like, like, q.replace(/^#/, ''));
    }
    const rows = db.prepare(`${repo.DEAL_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC LIMIT 51 OFFSET ?`).all(...params, (page - 1) * 50);
    return { items: rows.slice(0, 50).map((r) => ({ ...repo.serializeDeal(r), mergedInto: r.merged_into })), page, hasMore: rows.length > 50 };
  });

  route('POST', '/api/admin/deals/:id/remove', MOD, ({ params, body, user }) => {
    const reason = str(body.reason, 'Reason', { required: true, max: 300 });
    const id = Number(params.id);
    tx(db, () => {
      repo.removeDeal(id, user.id);
      repo.resolveReports('deal', id, user.id);
      repo.logAction(user.id, 'deal', id, 'remove', reason);
    });
    return { ok: true };
  });

  route('POST', '/api/admin/deals/:id/restore', MOD, ({ params, body, user }) => {
    const id = Number(params.id);
    const restored = tx(db, () => {
      const n = repo.restoreDeal(id);
      repo.logAction(user.id, 'deal', id, 'restore', str(body.reason, 'Reason', { max: 300 }));
      return n;
    });
    return { ok: true, restoredOffers: restored };
  });

  route('GET', '/api/admin/duplicates', MOD, () => ({ items: repo.duplicatePairs(50) }));

  route('POST', '/api/admin/deals/:id/merge', MOD, ({ params, body, user }) => {
    const sourceId = Number(params.id);
    const targetId = Number(String(body.intoId ?? '').replace(/^#/, ''));
    if (!Number.isInteger(targetId) || targetId <= 0) throw new HttpError(400, 'Enter the id of the deal to merge into');
    const reason = str(body.reason, 'Reason', { max: 300 });
    const result = tx(db, () => {
      const r = repo.mergeDeals(sourceId, targetId, user.id);
      repo.resolveReports('deal', sourceId, user.id);
      repo.logAction(user.id, 'deal', sourceId, `merge into #${targetId}`, reason);
      return r;
    });
    return { ok: true, ...result };
  });

  // ------------------------------------------------------------ store listings

  route('POST', '/api/admin/offers/:id/remove', MOD, ({ params, body, user }) => {
    const reason = str(body.reason, 'Reason', { required: true, max: 300 });
    const id = Number(params.id);
    tx(db, () => {
      repo.setOfferStatus(id, 'removed', user.id);
      repo.resolveReports('offer', id, user.id);
      repo.logAction(user.id, 'offer', id, 'remove', reason);
    });
    return { ok: true };
  });

  route('POST', '/api/admin/offers/:id/restore', MOD, ({ params, body, user }) => {
    const id = Number(params.id);
    tx(db, () => {
      repo.setOfferStatus(id, 'active', user.id);
      repo.logAction(user.id, 'offer', id, 'restore', str(body.reason, 'Reason', { max: 300 }));
    });
    return { ok: true };
  });

  // ------------------------------------------------------------ comments

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
      repo.resolveReports('comment', id, user.id);
      repo.logAction(user.id, 'comment', id, 'remove', reason);
      return { ok: true };
    });
  });

  route('POST', '/api/admin/comments/:id/restore', MOD, ({ params, body, user }) => {
    const id = Number(params.id);
    return tx(db, () => {
      const r = db.prepare("UPDATE comments SET status = 'visible' WHERE id = ? AND status = 'removed'").run(id);
      if (!r.changes) throw new HttpError(404, 'Comment not found or not removed');
      repo.logAction(user.id, 'comment', id, 'restore', str(body.reason, 'Reason', { max: 300 }));
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ users (Admin only — Open Q #7)

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
                (SELECT COUNT(*) FROM offers o WHERE o.submitted_by = u.id) AS offer_count,
                (SELECT COUNT(*) FROM offers o WHERE o.submitted_by = u.id AND o.status = 'removed') AS removed_offer_count,
                (SELECT COUNT(*) FROM deals d WHERE d.submitted_by = u.id AND d.status = 'removed' AND d.merged_into IS NULL) AS removed_count,
                (SELECT COUNT(*) FROM comments c WHERE c.user_id = u.id) AS comment_count
           FROM users u WHERE ${where}
          ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END, u.created_at DESC LIMIT 200`,
      )
      .all(...params);
    return {
      items: rows.map((r) => ({
        id: r.id, email: r.email, handle: r.handle, role: r.role, status: r.status, createdAt: r.created_at, dealCount: r.deal_count,
        offerCount: r.offer_count, removedCount: r.removed_count + r.removed_offer_count, commentCount: r.comment_count,
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
      repo.logAction(user.id, 'user', target.id, status === 'active' ? 'reinstate' : status === 'banned' ? 'ban' : 'suspend', reason);
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
      repo.logAction(user.id, 'user', target.id, role === 'moderator' ? 'promote_moderator' : 'demote_user', str(body.reason, 'Reason', { max: 300 }));
    });
    return { ok: true };
  });

  // ------------------------------------------------------------ categories (Admin only)

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
      repo.logAction(user.id, 'category', id, 'create', name);
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
    repo.logAction(user.id, 'category', id, name !== cat.name ? `rename (${cat.name} → ${name})` : active ? 'activate' : 'deactivate');
    return { ok: true };
  });

  // ------------------------------------------------------------ audit log (mods: own, admins: all)

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
      if (r.target_type === 'offer') {
        const o = db.prepare('SELECT o.store, o.price_cents, d.title FROM offers o JOIN deals d ON d.id = o.deal_id WHERE o.id = ?').get(r.target_id);
        return o && `${o.store} ₹${cents(o.price_cents).toLocaleString('en-IN')} · ${o.title}`;
      }
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
}
