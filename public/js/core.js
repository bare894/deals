// Core client utilities: safe templating, API client, formatting, toasts, router.

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const renderVal = (v) => (v == null || v === false ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(renderVal).join('') : esc(v));
/** Auto-escaping template tag. Nest html`` results freely; plain values are always escaped. */
export const html = (strings, ...vals) => new Raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? renderVal(vals[i]) : ''), ''));

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const state = { user: null, categories: [] };
export const isMod = () => Boolean(state.user && ['moderator', 'admin'].includes(state.user.role));
export const isAdmin = () => state.user?.role === 'admin';

export async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (method !== 'GET') {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ------------------------------------------------------------ formatting (India: ₹, en-IN)

export const money = (n) =>
  n == null ? '' : n === 0 ? 'FREE' : `₹${n.toLocaleString('en-IN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
export const parseMoney = (s) => Number(String(s).replace(/^\s*(?:₹|rs\.?|inr)/i, '').replace(/[₹,\s]/g, ''));

export function timeAgo(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString('en-IN');
}
export const fullDate = (ts) => new Date(ts).toLocaleString('en-IN');
export const placeholder = (t) => `/img/placeholder.svg?t=${encodeURIComponent(t || 'Deal')}`;

export function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 3600);
}

// Broken/blocked product images fall back to a generated placeholder (CSP forbids inline onerror).
document.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (img.tagName === 'IMG' && !img.dataset.fallback) {
      img.dataset.fallback = '1';
      img.src = placeholder(img.dataset.label);
    }
  },
  true,
);

// ------------------------------------------------------------ router

const app = () => $('#app');
let routes = [];
let routeSeq = 0;
let pageCleanup = null;
let onRouteChange = () => {};

export function setRoutes(list, { onChange } = {}) {
  routes = list;
  if (onChange) onRouteChange = onChange;
}

/** Pages call this to register teardown (observers, timers) for when the user navigates away. */
export function onLeave(fn) {
  pageCleanup = fn;
}

export function navigate(url, { replace = false } = {}) {
  history[replace ? 'replaceState' : 'pushState']({}, '', url);
  renderRoute();
  window.scrollTo(0, 0);
}

export function goLogin() {
  navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
}

export function setPage(title, content) {
  document.title = title ? `${title} — ShareDeals` : 'ShareDeals — community-vetted deals in India';
  app().innerHTML = String(content);
}

export function emptyState(title, body, action = '') {
  return html`<div class="empty"><h2>${title}</h2><p>${body}</p>${action}</div>`;
}

export async function renderRoute() {
  pageCleanup?.();
  pageCleanup = null;
  const seq = ++routeSeq;
  const url = new URL(location.href);
  onRouteChange(url);
  for (const [re, page] of routes) {
    const m = url.pathname.match(re);
    if (!m) continue;
    try {
      await page({ params: m.slice(1), query: url.searchParams, alive: () => seq === routeSeq });
    } catch (err) {
      if (seq !== routeSeq) return;
      if (err.status === 401) return goLogin();
      setPage('Error', emptyState(err.status === 404 ? 'Not found' : 'Something went wrong', err.message, html`<a class="btn" href="/">Back to home</a>`));
    }
    return;
  }
  setPage('Not found', emptyState('Page not found', "We couldn't find that page.", html`<a class="btn" href="/">Back to home</a>`));
}

window.addEventListener('popstate', renderRoute);
