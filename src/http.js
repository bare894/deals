// Small HTTP toolkit: errors, input validation, router, rate limiter.

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// Prices are stored as integer paise (1/100 rupee) and exposed as rupees.
export const cents = (c) => (c == null ? null : c / 100);
export const inr = (n) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export function toCents(v, field, { required = false } = {}) {
  if (v === '' || v == null) {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  const n = typeof v === 'number' ? v : Number(String(v).replace(/^\s*(?:₹|rs\.?|inr)/i, '').replace(/[₹,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw new HttpError(400, `${field} must be a valid amount`);
  return Math.round(n * 100);
}

export function str(v, field, { min = 0, max, required = false } = {}) {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  if (required && !s) throw new HttpError(400, `${field} is required`);
  if (s && s.length < min) throw new HttpError(400, `${field} must be at least ${min} characters`);
  if (max && s.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return s;
}

export function intParam(v, def, { min = 1, max = Infinity } = {}) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

export function isUniqueViolation(err) {
  return err?.code === '23505'; // Postgres unique_violation
}

/**
 * The visitor's IP, for rate limits. Behind a reverse proxy (Railway, Caddy) the socket address
 * is the proxy's, so with TRUST_PROXY=<number of proxies> we take the address the outermost
 * trusted proxy appended to X-Forwarded-For. Entries further left are client-supplied and ignored.
 */
export function clientIp(req, trustedHops = Number(process.env.TRUST_PROXY || 0)) {
  const socketIp = req.socket.remoteAddress;
  if (!trustedHops) return socketIp;
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return chain[chain.length - trustedHops] || socketIp;
}

export function makeRateLimiter(limits, enabled = true) {
  const hits = new Map();
  return function rateLimit(name, key) {
    if (!enabled) return;
    const [limit, windowMs] = limits[name];
    const now = Date.now();
    const k = `${name}:${key}`;
    const recent = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      hits.set(k, recent);
      throw new HttpError(429, "You're doing that too often — please wait a bit and try again.");
    }
    recent.push(now);
    hits.set(k, recent);
    if (hits.size > 50_000) hits.clear(); // crude memory cap for a single-process server
  };
}

/** Pattern router: route('GET', '/api/deals/:id', { auth: true }, handler). */
export function createRouter() {
  const routes = [];
  function route(method, pattern, opts, handler) {
    if (typeof opts === 'function') [handler, opts] = [opts, {}];
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, re, keys, opts, handler });
  }
  function match(method, pathname) {
    let methodMismatch = false;
    for (const r of routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.method !== method) {
        methodMismatch = true;
        continue;
      }
      return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    throw new HttpError(methodMismatch ? 405 : 404, methodMismatch ? 'Method not allowed' : 'Not found');
  }
  return { route, match };
}

export async function readJson(req, maxBytes = 100_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw new HttpError(413, 'Request too large');
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
