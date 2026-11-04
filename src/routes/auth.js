import { createHash, randomBytes } from 'node:crypto';
import { tx } from '../db.js';
import { HttpError, str, isUniqueViolation } from '../http.js';
import { createSession, destroySession, hashPassword, sessionCookie, verifyPassword } from '../auth.js';
import { APPROVED_STORES, publicUser } from './common.js';

const DELETE_PHRASE = 'DELETE MY ACCOUNT';

const RESET_TTL_MS = 60 * 60 * 1000;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function registerAuthRoutes({ route, db, rateLimit, mailer, publicBase, secureCookies, oauthProviders = [], approvedStores = APPROVED_STORES }) {
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
   * Forgot password, step 1: email a one-hour reset link. Always answers the same way, so it
   * can't be used to find out which emails have accounts.
   */
  route('POST', '/api/auth/forgot', async ({ body, ip }) => {
    rateLimit('forgot', ip);
    const email = str(body.email, 'Email', { required: true, max: 200 }).toLowerCase();
    rateLimit('forgot', `email:${email}`);
    const sent = { ok: true, message: 'If an account uses that email, we have sent a link to reset the password. Check your inbox and spam folder.' };
    if (!mailer.configured && process.env.NODE_ENV === 'production') {
      throw new HttpError(503, 'Password reset by email is not available yet. Please email info@sharedeals.in for help.');
    }
    const u = await db.get("SELECT id, handle, email FROM users WHERE lower(email) = ? AND status IN ('active', 'suspended')", email);
    if (!u) return sent;
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    await db.run('DELETE FROM password_resets WHERE user_id = ?', u.id);
    await db.run('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', sha256(token), u.id, now, now + RESET_TTL_MS);
    const link = `${publicBase()}/reset-password?token=${token}`;
    // Sent in the background: the answer comes back at once, and takes the same time whether or
    // not the account exists.
    mailer.send({
      to: u.email,
      subject: 'Reset your ShareDeals password',
      text: `Hi @${u.handle},\n\nSomeone (hopefully you) asked to reset the password for your ShareDeals account. Open this link within an hour to choose a new one:\n\n${link}\n\nIf you didn't ask for this, ignore this email. Your password won't change.\n\n- ShareDeals.in`,
    }).catch((err) => console.error(`[mail] password reset to user ${u.id} failed: ${err.message}`));
    return sent;
  });

  /** Forgot password, step 2: set a new password with the emailed token. Signs out everywhere. */
  route('POST', '/api/auth/reset', async ({ body, ip }) => {
    rateLimit('login', ip);
    const row = await db.get('SELECT * FROM password_resets WHERE token_hash = ?', sha256(String(body.token || '')));
    if (!row || row.used_at || row.expires_at < Date.now()) throw new HttpError(400, 'This reset link is invalid or has expired. Ask for a new one.');
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    await tx(db, async () => {
      await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), row.user_id);
      await db.run('UPDATE password_resets SET used_at = ? WHERE token_hash = ?', Date.now(), row.token_hash);
      await db.run('DELETE FROM sessions WHERE user_id = ?', row.user_id);
    });
    return { ok: true };
  });

  /** Change my password. Needs the current one; signs out every other session. Usernames can't be changed. */
  route('POST', '/api/me/password', { auth: true }, async ({ body, user, token }) => {
    const { password_hash: hash } = await db.get('SELECT password_hash FROM users WHERE id = ?', user.id);
    if (!hash) throw new HttpError(400, 'Your account signs in with Google or Facebook, so it has no password to change.');
    rateLimit('login', `password:${user.id}`);
    if (!verifyPassword(String(body.current || ''), hash)) throw new HttpError(401, 'Your current password is incorrect');
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
    if (password === body.current) throw new HttpError(400, 'New password must be different from your current one');
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), user.id);
    await db.run('DELETE FROM sessions WHERE user_id = ? AND token <> ?', user.id, token);
    return { ok: true };
  });

  /**
   * Delete my account (Google Play requires this in-app, plus a web page: /delete-account).
   * Personal data goes: email, sign-ins, sessions, comments, votes, saves, views, reports.
   * The deals and store links they posted stay up, credited to an anonymous "deleted_…" account.
   */
  route('DELETE', '/api/me', { auth: true }, async ({ body, user, setCookie }) => {
    if (String(body.confirm || '').toLowerCase() !== user.handle.toLowerCase()) throw new HttpError(400, `Type your username (${user.handle}) to confirm`);
    if (String(body.phrase || '').trim().toUpperCase() !== DELETE_PHRASE) throw new HttpError(400, `Type ${DELETE_PHRASE} to confirm`);
    if (user.role === 'admin') throw new HttpError(403, 'Admin accounts cannot be deleted here. Ask another admin to remove your admin role first.');
    // Accounts with a password must re-enter it (Google/Facebook-only accounts have none).
    const { password_hash: hash } = await db.get('SELECT password_hash FROM users WHERE id = ?', user.id);
    if (hash) {
      rateLimit('login', `delete:${user.id}`);
      if (!verifyPassword(String(body.password || ''), hash)) throw new HttpError(401, 'Incorrect password');
    }
    await tx(db, async () => {
      // Take the user's votes back out of deal scores before deleting them.
      await db.run(
        `UPDATE deals d SET upvotes = d.upvotes - v.up, downvotes = d.downvotes - v.down, score = d.score - (v.up - v.down)
           FROM (SELECT deal_id, COUNT(*) FILTER (WHERE value = 1) AS up, COUNT(*) FILTER (WHERE value = -1) AS down
                   FROM votes WHERE user_id = ? GROUP BY deal_id) v
          WHERE d.id = v.deal_id`,
        user.id,
      );
      for (const table of ['votes', 'bookmarks', 'views', 'comments', 'sessions', 'oauth_identities', 'app_login_codes', 'feedback', 'password_resets', 'page_views', 'push_tokens', 'push_log', 'alerts']) {
        await db.run(`DELETE FROM ${table} WHERE user_id = ?`, user.id);
      }
      await db.run('DELETE FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?', user.id, user.id);
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
