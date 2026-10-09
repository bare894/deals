// HTTP application: wires the router, route modules, static files and the SPA shell.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { autoPopulate, resolveShortener } from './scrape.js';
import { SESSION_COOKIE, parseCookies, userForToken } from './auth.js';
import { HttpError, clientIp, createRouter, escapeHtml, inr, makeRateLimiter, readJson } from './http.js';
import { createRepo } from './repo.js';
import { ROLE_RANK } from './routes/common.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDealRoutes } from './routes/deals.js';
import { registerOfferRoutes } from './routes/offers.js';
import { registerAdminRoutes } from './routes/admin.js';
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
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
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
  oauthFetch,
}) {
  const { route, match } = createRouter();
  const repo = createRepo(db);
  const rateLimit = makeRateLimiter(RATE_LIMITS, rateLimits);
  const oauth = createOAuth({ db, config: oauthConfig, secureCookies, baseUrl: (req) => baseUrl(req), rateLimit, fetchImpl: oauthFetch });
  const ctx = { route, db, repo, rateLimit, scraper, resolveUrl, secureCookies, oauthProviders: oauth.enabled };
  registerAuthRoutes(ctx);
  registerDealRoutes(ctx);
  registerOfferRoutes(ctx);
  registerAdminRoutes(ctx);

  // ------------------------------------------------------------ responses

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

  // Server-rendered Open Graph tags so shared deal links unfurl in WhatsApp/Slack/iMessage (§14).
  async function renderIndex(req, dealId) {
    let html = await indexHtml();
    let tags = '';
    const row = dealId && (await repo.getDealRow(dealId));
    if (row && row.status === 'active') {
      const d = repo.serializeDeal(row);
      const price = d.price === 0 ? 'FREE' : d.price != null ? inr(d.price) : '';
      const desc = [
        price && `${price} on ${d.store}`,
        d.fullPrice ? `(MRP ${inr(d.fullPrice)}${d.discountPct ? `, ${d.discountPct}% off` : ''})` : '',
        d.offerCount > 1 ? `· compare ${d.offerCount} stores` : '',
        `· ${d.score >= 0 ? '+' : ''}${d.score} votes`,
      ]
        .filter(Boolean)
        .join(' ');
      const url = `${baseUrl(req)}/deals/${d.id}`;
      const imagePath = d.imageUrl || `/img/placeholder.svg?t=${encodeURIComponent(d.title.slice(0, 20))}`;
      const image = imagePath.startsWith('/') ? `${baseUrl(req)}${imagePath}` : imagePath;
      tags = [
        ['og:type', 'product'], ['og:site_name', 'ShareDeals'], ['og:title', d.title], ['og:description', desc], ['og:url', url], ['og:image', image],
        ['product:price:amount', d.price?.toFixed(2)], ['product:price:currency', 'INR'], ['og:locale', 'en_IN'],
      ]
        .map(([p, c]) => `<meta property="${p}" content="${escapeHtml(c)}">`)
        .concat([
          '<meta name="twitter:card" content="summary_large_image">',
          `<link rel="canonical" href="${escapeHtml(url)}">`,
          // Deep-link hint for the native apps (Phase 4); app ids are placeholders until the apps exist.
          `<meta property="al:web:url" content="${escapeHtml(url)}">`,
        ])
        .join('\n    ');
      html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(d.title)} — ShareDeals</title>`);
    } else {
      // Every other page unfurls as the site itself, with the logo card.
      tags = [
        ['og:type', 'website'], ['og:site_name', 'ShareDeals'], ['og:title', 'ShareDeals.in — community-vetted deals in India'],
        ['og:description', 'Find, vote on, and share the best deals from Flipkart, Amazon, Myntra, AJIO, Nykaa, Meesho and more.'],
        ['og:url', `${baseUrl(req)}/`], ['og:image', `${baseUrl(req)}/img/og-image.png`], ['og:locale', 'en_IN'],
      ]
        .map(([p, c]) => `<meta property="${p}" content="${escapeHtml(c)}">`)
        .concat(['<meta name="twitter:card" content="summary_large_image">'])
        .join('\n    ');
    }
    return html.replace('<!--OG-->', tags);
  }

  async function serveStatic(res, pathname) {
    const file = path.normalize(path.join(publicDir, decodeURIComponent(pathname)));
    if (!file.startsWith(publicDir + path.sep)) return false;
    try {
      const s = await stat(file);
      if (!s.isFile()) return false;
      send(res, 200, await readFile(file), {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': process.env.NODE_ENV === 'production' ? 'public, max-age=3600' : 'no-cache',
      });
      return true;
    } catch {
      return false;
    }
  }

  // CSRF defense: cross-site forms can't send JSON, and browsers send Origin on cross-site POSTs.
  function checkCsrf(req) {
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
    const body = mutating ? await readJson(req) : {};
    const result = await r.handler({
      req, params, query: url.searchParams, body, user, token, ip: clientIp(req), setCookie: (c) => cookies.push(c),
    });
    send(res, 200, result, cookies.length ? { 'set-cookie': cookies } : {});
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    try {
      if (pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
      if (pathname.startsWith('/auth/') && (await oauth.handle(req, res, url, send))) return;

      if (pathname === '/img/placeholder.svg') {
        const t = url.searchParams.get('t') || 'Deal';
        const hue = Number(url.searchParams.get('h') ?? [...t].reduce((a, c) => a + c.charCodeAt(0), 0) % 360);
        return send(res, 200, placeholderSvg(t, hue), { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
      }

      if (pathname !== '/' && (await serveStatic(res, pathname))) return;

      // SPA fallback (history routing); deal pages get OG tags, merged deals redirect.
      const dealMatch = pathname.match(/^\/deals\/(\d{1,9})$/);
      if (dealMatch) {
        const merged = (await db.get('SELECT merged_into FROM deals WHERE id = ?', Number(dealMatch[1])))?.merged_into;
        if (merged) return send(res, 301, '', { location: `/deals/${merged}` });
      }
      if (path.extname(pathname) && !dealMatch) return send(res, 404, 'Not found', { 'content-type': 'text/plain' });
      const html = await renderIndex(req, dealMatch ? Number(dealMatch[1]) : null);
      return send(res, 200, html, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...err.extra });
      // Malformed or out-of-range ids in the URL (Postgres: invalid_text_representation, numeric_value_out_of_range).
      if (err?.code === '22P02' || err?.code === '22003') return send(res, 404, { error: 'Not found' });
      console.error(err);
      return send(res, 500, { error: 'Something went wrong' });
    }
  };
}
