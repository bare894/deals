// Social sign-in (Google, Facebook) via the OAuth 2.0 authorization-code flow, server side.
// A provider is enabled only when its client id + secret are configured; the login page
// shows a button for each enabled provider (GET /api/meta → oauth).
//
//   GET /auth/:provider/start?next=/path  → 302 to the provider, CSRF state in a short-lived cookie
//   GET /auth/:provider/callback          → exchange code, find/link/create the user, start a session
//
// Failures redirect to /login?error=<code> (codes, never free text, so links can't inject messages).
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { createSession, parseCookies, sessionCookie } from './auth.js';
import { HttpError, clientIp } from './http.js';

const STATE_COOKIE = 'oauth_state';
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

  /** Handles /auth/* requests. Returns false when the path isn't an OAuth route. */
  async function handle(req, res, url, sendRaw) {
    const send = (...args) => (sendRaw(...args), true);
    const m = url.pathname.match(/^\/auth\/([a-z]+)\/(start|callback)$/);
    if (!m) return false;
    const [, provider, step] = m;
    const fail = (code, cookies) => send(res, 302, '', { location: `/login?error=${code}`, ...(cookies ? { 'set-cookie': cookies } : {}) });
    if (!enabled.includes(provider)) return fail('unavailable');
    const { clientId, clientSecret } = config[provider];
    const redirectUri = `${baseUrl(req)}/auth/${provider}/callback`;

    if (step === 'start') {
      const state = randomBytes(24).toString('base64url');
      const next = Buffer.from(safeNext(url.searchParams.get('next'))).toString('base64url');
      const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', state, ...PROVIDERS[provider].authorizeParams });
      return send(res, 302, '', { location: `${PROVIDERS[provider].authorizeUrl}?${q}`, 'set-cookie': [stateCookie(`${provider}.${state}.${next}`, 600)] });
    }

    // callback
    const clear = stateCookie('', 0);
    const [cProvider, cState, cNext] = String(parseCookies(req.headers.cookie)[STATE_COOKIE] || '').split('.');
    const state = url.searchParams.get('state');
    if (!state || cProvider !== provider || cState !== state) return fail('expired', [clear]);
    if (url.searchParams.get('error') || !url.searchParams.get('code')) return fail('cancelled', [clear]);
    try {
      rateLimit('oauth', clientIp(req));
      const profile = await PROVIDERS[provider].profile({ code: url.searchParams.get('code'), clientId, clientSecret, redirectUri }, fetchJson);
      if (!profile.subject) throw new Error('OAuth profile has no subject');
      const user = await resolveUser(provider, profile);
      if (user.status === 'banned') return fail('banned', [clear]);
      const { token, maxAge } = await createSession(db, user.id);
      const next = safeNext(Buffer.from(cNext || '', 'base64url').toString());
      return send(res, 302, '', { location: next, 'set-cookie': [clear, sessionCookie(token, maxAge, secureCookies)] });
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status === 429 ? 'rate_limited' : err.message, [clear]);
      console.error(`[oauth:${provider}]`, err.message);
      return fail('failed', [clear]);
    }
  }

  return { enabled, handle };
}
