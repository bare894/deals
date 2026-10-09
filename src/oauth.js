// Social sign-in (Google, Facebook) via the OAuth 2.0 authorization-code flow, server side.
// A provider is enabled only when its client id + secret are configured; the login page
// shows a button for each enabled provider (GET /api/meta → oauth).
//
//   GET /auth/:provider/start?next=/path  → 302 to the provider, CSRF state in a short-lived cookie
//   GET /auth/:provider/callback          → exchange code, find/link/create the user, start a session
//
// Failures redirect to /login?error=<code> (codes, never free text, so links can't inject messages).
import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';
import { createSession, parseCookies, sessionCookie } from './auth.js';
import { HttpError, clientIp, escapeHtml } from './http.js';

const STATE_COOKIE = 'oauth_state';
// The Android app's URL scheme (mobile/android). Google and Facebook refuse sign-in inside an
// app's WebView, so the app runs the flow in a Chrome tab (start?app=1&challenge=…) and we
// hand the result back through this scheme as a one-time code (see /auth/app/finish).
export const APP_SCHEME = 'in.sharedeals.app';
const APP_CODE_TTL_MS = 2 * 60_000;
const sha256url = (s) => createHash('sha256').update(s).digest('base64url');
const FB_GRAPH = 'https://graph.facebook.com/v21.0';

const PROVIDERS = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    authorizeParams: { scope: 'openid email profile', prompt: 'select_account' },
    async profile({ code, clientId, clientSecret, redirectUri }, fetchJson) {
      const tok = await fetchJson('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
      });
      const p = await fetchJson('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` } });
      return { subject: p.sub, email: p.email, emailVerified: p.email_verified === true, name: p.name };
    },
  },
  facebook: {
    authorizeUrl: 'https://www.facebook.com/v21.0/dialog/oauth',
    authorizeParams: { scope: 'email,public_profile' },
    async profile({ code, clientId, clientSecret, redirectUri }, fetchJson) {
      const q = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, code });
      const tok = await fetchJson(`${FB_GRAPH}/oauth/access_token?${q}`);
      const proof = createHmac('sha256', clientSecret).update(tok.access_token).digest('hex');
      const me = new URLSearchParams({ fields: 'id,name,email', access_token: tok.access_token, appsecret_proof: proof });
      const p = await fetchJson(`${FB_GRAPH}/me?${me}`);
      // Facebook only returns an email the person has confirmed.
      return { subject: p.id, email: p.email, emailVerified: Boolean(p.email), name: p.name };
    },
  },
};

/** Provider credentials from the environment; a provider without both values stays disabled. */
export function oauthConfigFromEnv(env = process.env) {
  const cfg = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) cfg.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  if (env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET) cfg.facebook = { clientId: env.FACEBOOK_APP_ID, clientSecret: env.FACEBOOK_APP_SECRET };
  return cfg;
}

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/');

/** Derive an unused handle ("Priya Sharma" → priya_sharma, then priya_sharma42 …). */
async function uniqueHandle(db, name, email) {
  let base = String(name || String(email).split('@')[0] || '')
    .normalize('NFKD')
    .replace(/[^\w]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 18);
  if (base.length < 3) base = `user_${base}`.slice(0, 18);
  const taken = (h) => db.get('SELECT 1 FROM users WHERE lower(handle) = lower(?)', h);
  if (!(await taken(base))) return base;
  for (let i = 0; i < 50; i++) {
    const h = `${base}${randomInt(10, 99999)}`;
    if (!(await taken(h))) return h;
  }
  return `${base}_${randomBytes(3).toString('hex')}`;
}

export function createOAuth({ db, config, secureCookies, baseUrl, rateLimit, fetchImpl = fetch }) {
  const enabled = Object.keys(PROVIDERS).filter((p) => config[p]);

  async function fetchJson(url, init = {}) {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(`OAuth request failed (${res.status}): ${JSON.stringify(data.error || data).slice(0, 200)}`);
    return data;
  }

  const stateCookie = (value, maxAge) =>
    `${STATE_COOKIE}=${value}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;

  /** Find the linked account, else link by verified email, else create one. Returns a users row. */
  async function resolveUser(provider, { subject, email, emailVerified, name }) {
    const linked = await db.get('SELECT u.* FROM oauth_identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ? AND i.subject = ?', provider, String(subject));
    if (linked) return linked;
    if (!email) throw new HttpError(400, 'no_email');
    if (!emailVerified) throw new HttpError(400, 'unverified');
    const link = (userId) =>
      db.run('INSERT INTO oauth_identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', provider, String(subject), userId, Date.now());
    const existing = await db.get('SELECT * FROM users WHERE lower(email) = lower(?)', email);
    if (existing) {
      await link(existing.id);
      return existing;
    }
    // Social-only accounts have no password; '' never verifies (see verifyPassword).
    return db.tx(async () => {
      const user = await db.get(
        "INSERT INTO users (email, handle, password_hash, created_at) VALUES (?, ?, '', ?) RETURNING *",
        email.toLowerCase(), await uniqueHandle(db, name, email), Date.now(),
      );
      await link(user.id);
      return user;
    });
  }

  /** Back to the app via its URL scheme. A page (not a bare 302), so there's a button if the tab doesn't switch by itself. */
  function toApp(res, send, params, cookies) {
    const target = `${APP_SCHEME}://auth?${new URLSearchParams(params)}`;
    const t = escapeHtml(target);
    const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=${t}"><title>Back to ShareDeals</title>
<body style="font:16px system-ui,sans-serif;text-align:center;padding:48px 16px">
<p>${params.error ? 'Sign-in did not complete.' : 'Signed in.'}</p>
<p><a href="${t}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#ec0276;color:#fff;text-decoration:none;font-weight:600">Return to the ShareDeals app</a></p></body>`;
    return send(res, 200, body, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...(cookies ? { 'set-cookie': cookies } : {}) });
  }

  /** The app redeems the one-time code (plus its verifier) inside its WebView, which then gets the session cookie. */
  async function finishAppSignIn(req, res, url, send) {
    const code = url.searchParams.get('code') || '';
    const verifier = url.searchParams.get('verifier') || '';
    const fail = (e) => send(res, 302, '', { location: `/login?error=${e}` });
    const row = code && (await db.get('DELETE FROM app_login_codes WHERE code_hash = ? RETURNING user_id, challenge, next, expires_at', sha256url(code)));
    if (!row || row.expires_at < Date.now() || !verifier || sha256url(verifier) !== row.challenge) return fail('expired');
    const user = await db.get('SELECT id, status FROM users WHERE id = ?', row.user_id);
    if (!user || user.status === 'banned' || user.status === 'deleted') return fail('banned');
    const { token, maxAge } = await createSession(db, user.id);
    return send(res, 302, '', { location: safeNext(row.next), 'set-cookie': sessionCookie(token, maxAge, secureCookies) });
  }

  /** Handles /auth/* requests. Returns false when the path isn't an OAuth route. */
  async function handle(req, res, url, sendRaw) {
    const send = (...args) => (sendRaw(...args), true);
    if (url.pathname === '/auth/app/finish') return finishAppSignIn(req, res, url, send);
    const m = url.pathname.match(/^\/auth\/([a-z]+)\/(start|callback)$/);
    if (!m) return false;
    const [, provider, step] = m;
    // Only the app flow carries a challenge (in the state cookie); its failures go back to the app.
    let appChallenge = null;
    const fail = (code, cookies) =>
      appChallenge
        ? toApp(res, send, { error: code }, cookies)
        : send(res, 302, '', { location: `/login?error=${code}`, ...(cookies ? { 'set-cookie': cookies } : {}) });
    if (!enabled.includes(provider)) return fail('unavailable');
    const { clientId, clientSecret } = config[provider];
    const redirectUri = `${baseUrl(req)}/auth/${provider}/callback`;

    if (step === 'start') {
      const state = randomBytes(24).toString('base64url');
      const next = Buffer.from(safeNext(url.searchParams.get('next'))).toString('base64url');
      const challenge = url.searchParams.get('app') === '1' ? String(url.searchParams.get('challenge') || '') : '';
      if (challenge && !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail('failed');
      const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', state, ...PROVIDERS[provider].authorizeParams });
      const cookie = [provider, state, next, challenge].filter(Boolean).join('.');
      return send(res, 302, '', { location: `${PROVIDERS[provider].authorizeUrl}?${q}`, 'set-cookie': [stateCookie(cookie, 600)] });
    }

    // callback
    const clear = stateCookie('', 0);
    const [cProvider, cState, cNext, cChallenge] = String(parseCookies(req.headers.cookie)[STATE_COOKIE] || '').split('.');
    appChallenge = cChallenge || null;
    const state = url.searchParams.get('state');
    if (!state || cProvider !== provider || cState !== state) return fail('expired', [clear]);
    if (url.searchParams.get('error') || !url.searchParams.get('code')) return fail('cancelled', [clear]);
    try {
      rateLimit('oauth', clientIp(req));
      const profile = await PROVIDERS[provider].profile({ code: url.searchParams.get('code'), clientId, clientSecret, redirectUri }, fetchJson);
      if (!profile.subject) throw new Error('OAuth profile has no subject');
      const user = await resolveUser(provider, profile);
      if (user.status === 'banned' || user.status === 'deleted') return fail('banned', [clear]);
      const next = safeNext(Buffer.from(cNext || '', 'base64url').toString());
      if (appChallenge) {
        // This tab's cookies aren't the app's: hand over a one-time code instead of a session.
        const code = randomBytes(32).toString('base64url');
        await db.run(
          'INSERT INTO app_login_codes (code_hash, user_id, challenge, next, expires_at) VALUES (?, ?, ?, ?, ?)',
          sha256url(code), user.id, appChallenge, next, Date.now() + APP_CODE_TTL_MS,
        );
        await db.run('DELETE FROM app_login_codes WHERE expires_at < ?', Date.now());
        return toApp(res, send, { code }, [clear]);
      }
      const { token, maxAge } = await createSession(db, user.id);
      return send(res, 302, '', { location: next, 'set-cookie': [clear, sessionCookie(token, maxAge, secureCookies)] });
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status === 429 ? 'rate_limited' : err.message, [clear]);
      console.error(`[oauth:${provider}]`, err.message);
      return fail('failed', [clear]);
    }
  }

  return { enabled, handle };
}
