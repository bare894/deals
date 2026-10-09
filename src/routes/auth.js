import { HttpError, str, isUniqueViolation } from '../http.js';
import { createSession, destroySession, hashPassword, sessionCookie, verifyPassword } from '../auth.js';
import { publicUser } from './common.js';

export function registerAuthRoutes({ route, db, rateLimit, secureCookies }) {
  route('GET', '/api/meta', ({ user }) => ({
    user: publicUser(user),
    categories: db.prepare("SELECT id, name, slug FROM categories WHERE active = 1 ORDER BY name = 'Other', name").all().map((c) => ({ ...c })),
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
}
