// HTTP application: wires the router, route modules, static files and the SPA shell.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';
import { autoPopulate, resolveShortener } from './scrape.js';
import { SESSION_COOKIE, parseCookies, userForToken } from './auth.js';
import { HttpError, clientIp, createRouter, escapeHtml, makeRateLimiter, readJson } from './http.js';
import { createRepo } from './repo.js';
import { createSeo } from './seo.js';
import { INDEXNOW_KEY, createIndexNow } from './indexnow.js';
import { mailerFromEnv } from './mailer.js';
import { createPush } from './push.js';
import { sizedImage } from '../public/meta.js';
import { APPROVED_STORES, ROLE_RANK } from './routes/common.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDealRoutes } from './routes/deals.js';
import { registerOfferRoutes } from './routes/offers.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerFeedbackRoutes } from './routes/feedback.js';
import { registerHealthRoutes } from './routes/health.js';
import { createOAuth, oauthConfigFromEnv } from './oauth.js';

export { HttpError };

const MIN = 60_000;
const HOUR = 60 * MIN;
const RATE_LIMITS = {
  register: [5, HOUR],
  login: [20, 15 * MIN],
  submit: [15, HOUR],
  scrape: [40, 10 * MIN],
  vote: [120, 10 * MIN],
  comment: [20, 10 * MIN],
  report: [20, HOUR],
  oauth: [30, 15 * MIN],
  feedback: [10, HOUR],
  forgot: [5, HOUR],
  pageview: [600, HOUR],
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' https: http: data:; style-src 'self' 'unsafe-inline'; " +
    // Google Analytics: gtag.js loads from googletagmanager.com and sends hits to google-analytics.com.
    "script-src 'self' https://www.googletagmanager.com; " +
    "connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};

function placeholderSvg(text, hue) {
  const label = escapeHtml(String(text || 'Deal').slice(0, 24));
  const h = Number.isFinite(hue) ? hue : 210;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="450" viewBox="0 0 600 450">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},70%,62%)"/><stop offset="1" stop-color="hsl(${(h + 40) % 360},70%,45%)"/></linearGradient></defs>
<rect width="600" height="450" fill="url(#g)"/>
<text x="300" y="240" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif" font-size="44" font-weight="700" fill="#fff" text-anchor="middle">${label}</text></svg>`;
}

export function createApp({
  db,
  publicDir,
  scraper = autoPopulate,
  resolveUrl = resolveShortener,
  rateLimits = true,
  secureCookies = false,
  publicUrl = process.env.PUBLIC_URL,
  oauth: oauthConfig = oauthConfigFromEnv(),
  approvedStores = APPROVED_STORES,
  oauthFetch,
  // Only the live site pings search engines; tests and local runs never do.
  indexNow: indexNowEnabled = process.env.NODE_ENV === 'production',
  mailer = mailerFromEnv(),
  pushEnv = process.env,
  pushFetch,
}) {
  const { route, match } = createRouter();
  const repo = createRepo(db);
  const rateLimit = makeRateLimiter(RATE_LIMITS, rateLimits);
  const oauth = createOAuth({ db, config: oauthConfig, secureCookies, baseUrl: (req) => baseUrl(req), rateLimit, fetchImpl: oauthFetch });
  const seo = createSeo({ db, repo });
  const push = createPush({ db, repo, env: pushEnv, ...(pushFetch ? { fetchImpl: pushFetch } : {}) });
  const indexNow = createIndexNow({ db, baseUrl: (publicUrl || 'https://www.sharedeals.in').replace(/\/$/, ''), enabled: indexNowEnabled });
  const ctx = { route, db, repo, seo, push, mailer, publicBase: () => (publicUrl || 'https://www.sharedeals.in').replace(/\/$/, ''), rateLimit, scraper, resolveUrl, secureCookies, oauthProviders: oauth.enabled, approvedStores };
  registerAuthRoutes(ctx);
  registerDealRoutes(ctx);
  registerOfferRoutes(ctx);
  registerAdminRoutes(ctx);
  registerFeedbackRoutes(ctx);
  registerHealthRoutes(ctx);

  // ------------------------------------------------------------ responses

  /** `cacheKey` (static files only) lets the compressed copy be reused; it must change when the content does. */
  function send(res, status, body, headers = {}, cacheKey = null) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    const all = {
      ...SECURITY_HEADERS,
      ...(isJson ? { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } : {}),
      ...headers,
    };
    let out = isJson ? JSON.stringify(body) : body;
    // Compress text (HTML, CSS, JS, JSON, XML, SVG) when the browser accepts it.
    if (out && out.length > 1024 && /^(text\/|application\/(json|javascript|xml|manifest)|image\/svg)/.test(String(all['content-type'] || ''))) {
      const accept = String(res.req?.headers['accept-encoding'] || '');
      const enc = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
      if (enc) {
        out = compressed(out, enc, cacheKey);
        all['content-encoding'] = enc;
      }
      all.vary = 'Accept-Encoding';
    }
    res.writeHead(status, all);
    res.end(res.req?.method === 'HEAD' ? undefined : out);
  }

  // Static files are compressed once per version (keyed by path, size and mtime); everything else on the fly.
  const compressCache = new Map();
  function compressed(body, enc, cacheKey) {
    const key = cacheKey && `${enc}:${cacheKey}`;
    if (key && compressCache.has(key)) return compressCache.get(key);
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const out = enc === 'br' ? brotliCompressSync(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }) : gzipSync(buf);
    if (key) {
      if (compressCache.size > 200) compressCache.clear();
      compressCache.set(key, out);
    }
    return out;
  }

  function baseUrl(req) {
    if (publicUrl) return publicUrl.replace(/\/$/, '');
    const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
    return `${proto}://${req.headers.host}`;
  }

  let indexCache = null;
  // The stylesheet is inlined so the first render doesn't wait on a second request.
  async function indexHtml() {
    if (!indexCache || process.env.NODE_ENV !== 'production') {
      const [page, css] = await Promise.all([readFile(path.join(publicDir, 'index.html'), 'utf8'), readFile(path.join(publicDir, 'styles.css'), 'utf8')]);
      indexCache = page.replace('<link rel="stylesheet" href="/styles.css">', () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`);
    }
    return indexCache;
  }

  async function serveStatic(req, res, pathname) {
    const file = path.normalize(path.join(publicDir, decodeURIComponent(pathname)));
    if (!file.startsWith(publicDir + path.sep)) return false;
    try {
      const s = await stat(file);
      if (!s.isFile()) return false;
      // App code is revalidated on every load so a deploy shows up at once (a 304 when unchanged).
      const code = /\.(js|css|html|webmanifest)$/.test(file);
      const etag = `"${s.size.toString(36)}-${Math.floor(s.mtimeMs).toString(36)}"`;
      const headers = {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': process.env.NODE_ENV === 'production' && !code ? 'public, max-age=3600' : 'no-cache',
        etag,
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag, 'cache-control': headers['cache-control'] });
        res.end();
        return true;
      }
      send(res, 200, await readFile(file), headers, `${file}:${etag}`);
      return true;
    } catch {
      return false;
    }
  }

  // CSRF defense: cross-site forms can't send JSON, and browsers send Origin on cross-site POSTs.
  // Browser extensions are let through: a JSON POST from one needs either access to this site
  // (granted by the user, as for the ShareDeals extension's one-click posting) or a CORS
  // preflight, which we never approve.
  function checkCsrf(req) {
    const origin = req.headers.origin;
    if (origin && !/^(chrome|moz)-extension:\/\//.test(origin)) {
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

  /**
   * The API answers the first screen needs, embedded in the page so the app can render without
   * waiting on more round trips: site meta everywhere, plus the home feed on the home page.
   * Anything that fails is simply left out; the app then fetches it as usual.
   */
  async function bootData(req, pathname) {
    const paths = ['/api/meta', ...(pathname === '/' ? ['/api/home'] : [])];
    const user = await userForToken(db, parseCookies(req.headers.cookie)[SESSION_COOKIE]).catch(() => null);
    const out = {};
    for (const p of paths) {
      try {
        const { route: r, params } = match('GET', p);
        out[p] = await r.handler({ req, params, query: new URLSearchParams(), body: {}, user, token: null, ip: clientIp(req), setCookie: () => {} });
      } catch {
        /* the app fetches it */
      }
    }
    return out;
  }

  async function handleApi(req, res, url) {
    const { method } = req;
    const { route: r, params } = match(method, url.pathname);
    const mutating = method !== 'GET' && method !== 'HEAD';
    if (mutating) checkCsrf(req);

    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const user = await userForToken(db, token);
    if (r.opts.auth && !user) throw new HttpError(401, 'Please sign in to continue');
    if (r.opts.role && ROLE_RANK[user.role] < ROLE_RANK[r.opts.role]) throw new HttpError(403, 'You do not have permission to do that');
    if ((r.opts.active || r.opts.role) && user.status !== 'active') throw new HttpError(403, 'Your account is suspended');

    const cookies = [];
    const body = mutating ? await readJson(req, r.opts.maxBody) : {};
    const result = await r.handler({
      req, params, query: url.searchParams, body, user, token, ip: clientIp(req), setCookie: (c) => cookies.push(c),
    });
    send(res, 200, result, cookies.length ? { 'set-cookie': cookies } : {});
    if (mutating) indexNow.afterApi(method, url.pathname, body, result);
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    try {
      if (pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
      if (pathname.startsWith('/auth/') && (await oauth.handle(req, res, url, send))) return;

      // Android App Links: lets the app open sharedeals.in/deals/… links. ANDROID_CERT_SHA256 lists
      // the SHA-256 fingerprints of the app's signing certificates (Play Console → App integrity).
      if (pathname === '/.well-known/assetlinks.json') {
        const fingerprints = String(process.env.ANDROID_CERT_SHA256 || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
        const statements = fingerprints.length
          ? [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'in.sharedeals.app', sha256_cert_fingerprints: fingerprints } }]
          : [];
        return send(res, 200, JSON.stringify(statements), { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' });
      }

      if (pathname === '/img/placeholder.svg') {
        const t = url.searchParams.get('t') || 'Deal';
        const hue = Number(url.searchParams.get('h') ?? [...t].reduce((a, c) => a + c.charCodeAt(0), 0) % 360);
        return send(res, 200, placeholderSvg(t, hue), { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
      }

      if (pathname !== '/' && (await serveStatic(req, res, pathname))) return;

      if (pathname === `/${INDEXNOW_KEY}.txt`) return send(res, 200, INDEXNOW_KEY, { 'content-type': 'text/plain; charset=utf-8' });
      if (pathname === '/robots.txt') return send(res, 200, seo.robots(baseUrl(req)), { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' });
      if (pathname === '/sitemap.xml') return send(res, 200, await seo.sitemap(baseUrl(req)), { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=900' });
      if (path.extname(pathname)) return send(res, 404, 'Not found', { 'content-type': 'text/plain' });

      // SPA fallback (history routing), with each page's head and main content rendered for
      // crawlers and link previews (src/seo.js). Merged deals and old URLs redirect.
      const p = await seo.page(baseUrl(req), pathname, url.searchParams);
      if (p.redirect) return send(res, p.status, '', { location: p.redirect });
      const boot = await bootData(req, pathname);
      // Home's largest image: the first For You card when signed in, else the first Latest card.
      const homeFirst = boot['/api/meta']?.user ? boot['/api/home']?.forYou?.[0] : boot['/api/home']?.latest?.[0];
      if (pathname === '/' && homeFirst?.imageUrl && !p.preloadImage) {
        const img = homeFirst.imageUrl;
        p.preloadImage = { href: sizedImage(img, 300), srcset: sizedImage(img, 300) !== img ? `${sizedImage(img, 300)} 1x, ${sizedImage(img, 600)} 2x` : null };
      }
      const page = seo.render(await indexHtml(), baseUrl(req), p).replace(
        '</body>',
        () => `<script type="application/json" id="boot-data">${JSON.stringify(boot).replace(/</g, '\\u003c')}</script>\n  </body>`,
      );
      // Personal (signed-in) data is embedded, so shared caches must not keep it.
      return send(res, p.status, page, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-cache' });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...err.extra });
      // Malformed or out-of-range ids in the URL (Postgres: invalid_text_representation, numeric_value_out_of_range).
      if (err?.code === '22P02' || err?.code === '22003') return send(res, 404, { error: 'Not found' });
      console.error(err);
      return send(res, 500, { error: 'Something went wrong' });
    }
  };
}
