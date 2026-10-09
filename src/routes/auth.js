import { randomBytes } from 'node:crypto';
import { tx } from '../db.js';
import { HttpError, str, isUniqueViolation } from '../http.js';
import { createSession, destroySession, hashPassword, sessionCookie, verifyPassword } from '../auth.js';
import { APPROVED_STORES, publicUser } from './common.js';

export function registerAuthRoutes({ route, db, rateLimit, secureCookies, oauthProviders = [], approvedStores = APPROVED_STORES }) {
  route('GET', '/api/meta', async ({ user }) => ({
    user: publicUser(user),
    oauth: oauthProviders,
    demo: process.env.NODE_ENV !== 'production',
    stores: approvedStores ? Object.values(approvedStores) : [],
    categories: await db.all("SELECT id, name, slug FROM categories WHERE active = 1 ORDER BY name = 'Other', name"),
  }));

  route('POST', '/api/auth/register', async ({ body, ip, setCookie }) => {
    rateLimit('register', ip);
    const email = str(body.email, 'Email', { required: true, max: 200 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Please enter a valid email');
    const handle = str(body.handle, 'Username', { required: true, min: 3, max: 24 });
    if (!/^[A-Za-z0-9_]+$/.test(handle)) throw new HttpError(400, 'Username may only contain letters, numbers, and underscores');
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    let id;
    try {
      ({ id } = await db.get('INSERT INTO users (email, handle, password_hash, created_at) VALUES (?, ?, ?, ?) RETURNING id', email, handle, hashPassword(password), Date.now()));
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, /email/.test(err.constraint || err.message) ? 'An account with that email already exists' : 'That username is taken');
      throw err;
    }
    const { token, maxAge } = await createSession(db, id);
    setCookie(sessionCookie(token, maxAge, secureCookies));
    return { user: publicUser(await db.get('SELECT * FROM users WHERE id = ?', id)) };
  });

  route('POST', '/api/auth/login', async ({ body, ip, setCookie }) => {
    rateLimit('login', ip);
    const login = str(body.login, 'Email or username', { required: true });
    const row = await db.get('SELECT * FROM users WHERE lower(email) = lower(?) OR lower(handle) = lower(?)', login, login);
    if (!row || !verifyPassword(String(body.password || ''), row.password_hash)) throw new HttpError(401, 'Incorrect email/username or password');
    if (row.status === 'banned') throw new HttpError(403, 'This account has been banned');
    if (row.status === 'deleted') throw new HttpError(401, 'Incorrect email/username or password');
    const { token, maxAge } = await createSession(db, row.id);
    setCookie(sessionCookie(token, maxAge, secureCookies));
    return { user: publicUser(row) };
  });

  /**
   * Delete my account (Google Play requires this in-app, plus a web page: /delete-account).
   * Personal data goes: email, sign-ins, sessions, comments, votes, saves, views, reports.
   * The deals and store links they posted stay up, credited to an anonymous "deleted_…" account.
   */
  route('DELETE', '/api/me', { auth: true }, async ({ body, user, setCookie }) => {
    if (String(body.confirm || '').toLowerCase() !== user.handle.toLowerCase()) throw new HttpError(400, `Type your username (${user.handle}) to confirm`);
    if (user.role === 'admin') throw new HttpError(403, 'Admin accounts cannot be deleted here. Ask another admin to remove your admin role first.');
    await tx(db, async () => {
      // Take the user's votes back out of deal scores before deleting them.
      await db.run(
        `UPDATE deals d SET upvotes = d.upvotes - v.up, downvotes = d.downvotes - v.down, score = d.score - (v.up - v.down)
           FROM (SELECT deal_id, COUNT(*) FILTER (WHERE value = 1) AS up, COUNT(*) FILTER (WHERE value = -1) AS down
                   FROM votes WHERE user_id = ? GROUP BY deal_id) v
          WHERE d.id = v.deal_id`,
        user.id,
      );
      for (const table of ['votes', 'bookmarks', 'views', 'comments', 'sessions', 'oauth_identities', 'app_login_codes']) {
        await db.run(`DELETE FROM ${table} WHERE user_id = ?`, user.id);
      }
      await db.run('DELETE FROM reports WHERE reporter_id = ?', user.id);
      const tag = randomBytes(4).toString('hex');
      await db.run(
        "UPDATE users SET email = ?, handle = ?, password_hash = '', role = 'user', status = 'deleted' WHERE id = ?",
        `deleted-${user.id}-${tag}@deleted.invalid`, `deleted_${tag}`, user.id,
      );
    });
    setCookie(sessionCookie('', 0, secureCookies));
    return { ok: true };
  });

  route('POST', '/api/auth/logout', async ({ token, setCookie }) => {
    await destroySession(db, token);
    setCookie(sessionCookie('', 0, secureCookies));
    return { ok: true };
  });
}
