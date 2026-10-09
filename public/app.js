// ShareDeals web client — vanilla JS SPA (history routing, no build step).

// ============================================================ utilities

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
const html = (strings, ...vals) => new Raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? renderVal(vals[i]) : ''), ''));

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const app = $('#app');

const state = { user: null, categories: [] };
let routeSeq = 0;
let pageCleanup = null;

async function api(path, { method = 'GET', body } = {}) {
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

// India-only site: rupees with Indian digit grouping (₹1,29,999).
const money = (n) =>
  n == null ? '' : n === 0 ? 'FREE' : `₹${n.toLocaleString('en-IN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const parseMoney = (s) => Number(String(s).replace(/^\s*(?:₹|rs\.?|inr)/i, '').replace(/[₹,\s]/g, ''));

function timeAgo(ts) {
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
const fullDate = (ts) => new Date(ts).toLocaleString('en-IN');
const placeholder = (t) => `/img/placeholder.svg?t=${encodeURIComponent(t || 'Deal')}`;
const isMod = () => state.user && ['moderator', 'admin'].includes(state.user.role);
const isAdmin = () => state.user?.role === 'admin';

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 3200);
}

function goLogin() {
  navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
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

// ============================================================ modal helpers

const modal = $('#modal');

function openModal(content, onSubmit) {
  modal.innerHTML = String(content);
  const form = $('form', modal);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(v);
    };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = $('.form-error', form);
      try {
        const v = await onSubmit(new FormData(form));
        done(v ?? true);
      } catch (err) {
        if (errBox) {
          errBox.hidden = false;
          errBox.textContent = err.message;
        }
      }
    });
    $$('[data-close]', modal).forEach((b) => b.addEventListener('click', () => done(null)));
    modal.addEventListener('close', () => done(null), { once: true });
    modal.showModal();
    $('textarea, input:not([type=radio]), input[type=radio]', form)?.focus();
  });
}

/** Ask for a moderation reason. Resolves to the reason string or null if cancelled. */
function askReason({ title, label = 'Reason', confirm = 'Confirm', danger = false, required = true, placeholderText = '' }) {
  return openModal(
    html`<form>
      <h2>${title}</h2>
      <div class="form-error" hidden></div>
      <div class="field"><label for="m-reason">${label}${required ? '' : ' (optional)'}</label>
        <textarea id="m-reason" name="reason" maxlength="300" placeholder="${placeholderText}" ${required ? 'required' : ''}></textarea></div>
      <div class="modal-actions">
        <button type="button" class="btn" data-close>Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${confirm}</button>
      </div>
    </form>`,
    (fd) => String(fd.get('reason') || '').trim() || '',
  ).then((v) => (v === null ? null : v === true ? '' : v));
}

const REPORT_REASONS = [
  ['spam', 'Spam or self-promotion'],
  ['expired', 'Deal expired / out of stock'],
  ['wrong_price', 'Wrong price or misleading'],
  ['duplicate', 'Duplicate of another deal'],
  ['offensive', 'Offensive or abusive'],
  ['other', 'Something else'],
];

function reportModal(type, id) {
  const reasons = type === 'comment' ? REPORT_REASONS.filter(([k]) => ['spam', 'offensive', 'other'].includes(k)) : REPORT_REASONS;
  return openModal(
    html`<form>
      <h2>Report ${type === 'deal' ? 'this deal' : 'this comment'}</h2>
      <div class="form-error" hidden></div>
      <div class="radio-list">
        ${reasons.map(([k, label], i) => html`<label><input type="radio" name="reason" value="${k}" ${i === 0 ? 'checked' : ''}> ${label}</label>`)}
      </div>
      <div class="field"><label for="m-note">Details (optional)</label><input id="m-note" name="note" maxlength="300"></div>
      <div class="modal-actions">
        <button type="button" class="btn" data-close>Cancel</button>
        <button class="btn btn-primary">Send report</button>
      </div>
    </form>`,
    async (fd) => {
      await api(`/api/${type === 'deal' ? 'deals' : 'comments'}/${id}/report`, { method: 'POST', body: { reason: fd.get('reason'), note: fd.get('note') } });
      toast('Thanks — a moderator will take a look.');
    },
  );
}

// ============================================================ shared components

function priceBlock(d, { mrpLabel = false } = {}) {
  return html`<div class="prices">
    <span class="price">${money(d.price)}</span>
    ${d.fullPrice ? html`${mrpLabel ? html`<span class="muted small">MRP</span>` : ''}<span class="was">${money(d.fullPrice)}</span>` : ''}
  </div>`;
}

function voteWidget(d, { large = false } = {}) {
  const mine = d.myVote || 0;
  const own = state.user && d.poster && state.user.id === d.poster.id;
  const dis = own ? html`disabled title="You can't vote on your own deal"` : '';
  return html`<div class="vote ${large ? 'lg' : ''}" data-vote-for="${d.id}" data-my="${mine}">
    <button class="vote-btn up ${mine === 1 ? 'on' : ''}" data-action="vote" data-id="${d.id}" data-value="1" aria-label="Upvote" aria-pressed="${mine === 1}" ${dis}>▲</button>
    <span class="vote-score" aria-label="Net score">${d.score}</span>
    <button class="vote-btn down ${mine === -1 ? 'on' : ''}" data-action="vote" data-id="${d.id}" data-value="-1" aria-label="Downvote" aria-pressed="${mine === -1}" ${dis}>▼</button>
  </div>`;
}

function dealCard(d, { hot = false, extra = '' } = {}) {
  const removed = d.status !== 'active';
  return html`<article class="card ${removed ? 'is-removed' : ''}">
    ${removed ? '' : html`<a class="card-link" href="/deals/${d.id}" aria-label="${d.title}"></a>`}
    <div class="card-media">
      <img src="${d.imageUrl || placeholder(d.store)}" data-label="${d.store}" alt="" loading="lazy">
      ${d.discountPct ? html`<span class="pill-off">−${d.discountPct}%</span>` : ''}
      ${hot && d.score >= 20 ? html`<span class="pill-hot">🔥 Hot</span>` : ''}
      ${removed ? html`<span class="removed-tag">No longer available</span>` : ''}
    </div>
    <div class="card-body">
      <div class="card-store">${d.store}</div>
      <h3 class="card-title">${d.title}</h3>
      ${priceBlock(d)}
      <div class="card-foot">
        ${removed ? '' : voteWidget(d)}
        <span title="Comments">💬 ${d.commentCount}</span>
        <span class="age" title="${fullDate(d.createdAt)}">${timeAgo(d.createdAt)}</span>
      </div>
      ${extra}
    </div>
  </article>`;
}

const skeletonCards = (n) => html`${Array.from({ length: n }, () => html`<div class="skeleton" style="aspect-ratio:3/4"></div>`)}`;

function emptyState(title, body, action = '') {
  return html`<div class="empty"><h2>${title}</h2><p>${body}</p>${action}</div>`;
}

function updateVoteWidgets(id, myVote, score) {
  for (const w of $$(`.vote[data-vote-for="${id}"]`)) {
    w.dataset.my = myVote;
    $('.vote-score', w).textContent = score;
    const up = $('.up', w);
    const down = $('.down', w);
    up.classList.toggle('on', myVote === 1);
    down.classList.toggle('on', myVote === -1);
    up.setAttribute('aria-pressed', myVote === 1);
    down.setAttribute('aria-pressed', myVote === -1);
  }
}

// ============================================================ global actions (event delegation)

const actions = {
  async vote(btn) {
    if (!state.user) return goLogin();
    const id = Number(btn.dataset.id);
    const widget = btn.closest('.vote');
    const clicked = Number(btn.dataset.value);
    const value = Number(widget.dataset.my) === clicked ? 0 : clicked; // same vote again clears it (§11)
    try {
      const r = await api(`/api/deals/${id}/vote`, { method: 'POST', body: { value } });
      updateVoteWidgets(id, r.myVote, r.score);
    } catch (err) {
      if (err.status === 401) return goLogin();
      toast(err.message, 'error');
    }
  },
  async bookmark(btn) {
    if (!state.user) return goLogin();
    const id = btn.dataset.id;
    const on = btn.classList.contains('on');
    try {
      await api(`/api/deals/${id}/bookmark`, { method: on ? 'DELETE' : 'PUT' });
      btn.classList.toggle('on', !on);
      btn.setAttribute('aria-pressed', !on);
      btn.querySelector('.lbl').textContent = on ? 'Save' : 'Saved';
      toast(on ? 'Removed from your wishlist' : 'Saved to your wishlist');
    } catch (err) {
      toast(err.message, 'error');
    }
  },
  async unbookmark(btn) {
    try {
      await api(`/api/deals/${btn.dataset.id}/bookmark`, { method: 'DELETE' });
      btn.closest('.card')?.remove();
      toast('Removed from your wishlist');
    } catch (err) {
      toast(err.message, 'error');
    }
  },
  async share(btn) {
    const url = `${location.origin}/deals/${btn.dataset.id}`;
    const title = btn.dataset.title;
    if (navigator.share) {
      try {
        await navigator.share({ title, url });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied to clipboard');
    } catch {
      openModal(
        html`<form><h2>Share this deal</h2><div class="field"><input class="input" value="${url}" readonly></div>
          <div class="modal-actions"><button class="btn btn-primary">Done</button></div></form>`,
        () => true,
      );
      $('input', modal).select();
    }
  },
  report(btn) {
    if (!state.user) return goLogin();
    reportModal(btn.dataset.type, btn.dataset.id);
  },
  async logout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    state.user = null;
    renderChrome();
    navigate('/');
    toast('Signed out');
  },
};

document.addEventListener('click', (e) => {
  const actionEl = e.target.closest('[data-action]');
  if (actionEl && actions[actionEl.dataset.action]) {
    e.preventDefault();
    actions[actionEl.dataset.action](actionEl, e);
    return;
  }
  const a = e.target.closest('a[href]');
  if (!a || a.target || a.hasAttribute('download') || a.origin !== location.origin) return;
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(a.pathname + a.search + a.hash);
});

// ============================================================ chrome (header + tab bar)

function renderChrome() {
  const u = state.user;
  const q = new URLSearchParams(location.search).get('q') || '';
  $('#topbar').innerHTML = String(html`<div class="topbar-inner">
    <a class="logo" href="/" aria-label="ShareDeals.in home"><picture class="logo-full"><source srcset="/img/logo-dark.png" media="(prefers-color-scheme: dark)"><img src="/img/logo.png" alt="ShareDeals.in" width="166" height="44"></picture><picture class="logo-mark"><source srcset="/img/mark-dark.png" media="(prefers-color-scheme: dark)"><img src="/img/mark.png" alt="ShareDeals.in" width="80" height="44"></picture></a>
    <form class="search" id="search-form" role="search">
      <input type="search" name="q" placeholder="Search deals or stores" aria-label="Search deals" value="${q}">
    </form>
    <nav class="nav">
      <a href="/deals?sort=hot" class="hide-sm" data-nav="/deals" data-sort="hot">Hot</a>
      <a href="/deals" class="hide-sm" data-nav="/deals" data-sort="new">All deals</a>
      ${u ? html`<a href="/saved" class="hide-sm" data-nav="/saved">Saved</a>` : ''}
      ${isMod() ? html`<a href="/admin" class="hide-sm" data-nav="/admin">Admin</a>` : ''}
      <a href="/submit" class="btn btn-primary btn-sm hide-sm">+ Post a deal</a>
      ${
        u
          ? html`<span class="user-chip"><span class="avatar" title="${u.handle}">${u.handle[0]}</span>
              <button class="linkish hide-sm" data-action="logout">Sign out</button></span>`
          : html`<a href="/login" data-nav="/login">Sign in</a>`
      }
    </nav>
  </div>`);
  $('#tabbar').innerHTML = String(html`
    <a href="/" data-nav="/"><span class="ico">⌂</span>Home</a>
    <a href="/deals" data-nav="/deals"><span class="ico">☰</span>Deals</a>
    <a href="/submit" class="post" data-nav="/submit"><span class="ico">+</span>Post</a>
    <a href="/saved" data-nav="/saved"><span class="ico">♡</span>Saved</a>
    ${u ? html`<a href="#" data-action="logout"><span class="ico">⎋</span>Sign out</a>` : html`<a href="/login" data-nav="/login"><span class="ico">☺</span>Sign in</a>`}
  `);
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = new FormData(e.target).get('q').trim();
    navigate(val ? `/deals?q=${encodeURIComponent(val)}` : '/deals');
  });
  markActiveNav();
}

function markActiveNav() {
  const p = location.pathname;
  const sort = new URLSearchParams(location.search).get('sort') === 'hot' ? 'hot' : 'new';
  for (const a of $$('[data-nav]')) {
    const target = a.dataset.nav;
    const pathMatch = target === '/' ? p === '/' : target === '/deals' ? p === '/deals' : p.startsWith(target);
    a.classList.toggle('active', pathMatch && (!a.dataset.sort || a.dataset.sort === sort));
  }
}

// ============================================================ router

const ROUTES = [
  [/^\/$/, homePage],
  [/^\/deals$/, listingsPage],
  [/^\/deals\/(\d+)$/, detailPage],
  [/^\/deals\/(\d+)\/edit$/, editPage],
  [/^\/submit$/, submitPage],
  [/^\/saved$/, savedPage],
  [/^\/login$/, loginPage],
  [/^\/register$/, registerPage],
  [/^\/admin(?:\/(\w+))?$/, adminPage],
];

function navigate(url, { replace = false } = {}) {
  history[replace ? 'replaceState' : 'pushState']({}, '', url);
  renderRoute();
  window.scrollTo(0, 0);
}
window.addEventListener('popstate', renderRoute);

async function renderRoute() {
  pageCleanup?.();
  pageCleanup = null;
  const seq = ++routeSeq;
  const url = new URL(location.href);
  markActiveNav();
  const search = $('#search-form input');
  if (search) search.value = url.pathname === '/deals' ? url.searchParams.get('q') || '' : '';
  for (const [re, page] of ROUTES) {
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

function setPage(title, content) {
  document.title = title ? `${title} — ShareDeals` : 'ShareDeals — community-vetted deals';
  app.innerHTML = String(content);
}

// ============================================================ pages: home (§6)

async function homePage({ alive }) {
  setPage(
    '',
    html`<div class="section"><div class="row-scroller">${skeletonCards(5)}</div></div><div class="section"><div class="row-scroller">${skeletonCards(5)}</div></div>`,
  );
  const data = await api('/api/home');
  if (!alive()) return;
  const section = (title, sub, items, href, opts = {}) => html`<section class="section">
    <div class="section-head"><h2>${title}</h2><span class="muted small">${sub}</span>${href ? html`<a class="see-all" href="${href}">See all →</a>` : ''}</div>
    ${items.length ? html`<div class="row-scroller">${items.map((d) => dealCard(d, opts))}</div>` : html`<p class="muted">Nothing here yet.</p>`}
  </section>`;
  const fySub = data.forYouPersonalized
    ? 'Based on what you vote on, save, and view'
    : state.user
      ? 'Trending for now — vote on or save a few deals to personalize this'
      : 'Trending for now — sign in to personalize';
  setPage(
    '',
    html`
      <nav class="chips" aria-label="Categories">
        <a class="chip active" href="/deals">All</a>
        ${state.categories.map((c) => html`<a class="chip" href="/deals?category=${c.slug}">${c.name}</a>`)}
      </nav>
      ${section('Latest', 'Fresh from the community', data.latest, '/deals')}
      ${section('🔥 Hot Deals', 'Most upvoted right now', data.hot, '/deals?sort=hot', { hot: true })}
      ${section('For You', fySub, data.forYou, null)}
    `,
  );
}

// ============================================================ pages: listings (§7)

async function listingsPage({ query, alive }) {
  const sort = query.get('sort') === 'hot' ? 'hot' : 'new';
  const category = query.get('category') || '';
  const q = query.get('q') || '';
  const cat = state.categories.find((c) => c.slug === category);
  const link = (patch) => {
    const p = new URLSearchParams({ ...(sort === 'hot' ? { sort } : {}), ...(category ? { category } : {}), ...(q ? { q } : {}), ...patch });
    for (const [k, v] of [...p]) if (!v) p.delete(k);
    const s = p.toString();
    return `/deals${s ? `?${s}` : ''}`;
  };
  const heading = q ? `Results for “${q}”` : cat ? cat.name : sort === 'hot' ? 'Hot Deals' : 'All deals';
  setPage(
    heading,
    html`
      <div class="page-head">
        <div><h1>${heading}</h1>${q ? html`<a class="small muted" href="${link({ q: '' })}">Clear search</a>` : ''}</div>
        <nav class="tabs" style="border:0;margin:0" aria-label="Sort">
          <a href="${link({ sort: '' })}" class="${sort === 'new' ? 'active' : ''}">Newest</a>
          <a href="${link({ sort: 'hot' })}" class="${sort === 'hot' ? 'active' : ''}">🔥 Hot</a>
        </nav>
      </div>
      <nav class="chips" aria-label="Categories">
        <a class="chip ${category ? '' : 'active'}" href="${link({ category: '' })}">All</a>
        ${state.categories.map((c) => html`<a class="chip ${c.slug === category ? 'active' : ''}" href="${link({ category: c.slug })}">${c.name}</a>`)}
      </nav>
      <div class="grid" id="feed">${skeletonCards(8)}</div>
      <div class="sentinel" id="sentinel"></div>
      <div class="load-more" id="load-more" hidden><button class="btn">Load more</button></div>
    `,
  );
  const feed = $('#feed');
  const moreBox = $('#load-more');
  let page = 0;
  let loading = false;
  let hasMore = true;
  async function load() {
    if (loading || !hasMore) return;
    loading = true;
    try {
      const params = new URLSearchParams({ sort, page: String(page + 1), limit: '24' });
      if (category) params.set('category', category);
      if (q) params.set('q', q);
      const data = await api(`/api/deals?${params}`);
      if (!alive()) return;
      if (page === 0) feed.innerHTML = '';
      page = data.page;
      hasMore = data.hasMore;
      feed.insertAdjacentHTML('beforeend', String(html`${data.items.map((d) => dealCard(d, { hot: sort === 'hot' }))}`));
      if (page === 1 && !data.items.length) {
        feed.outerHTML = String(
          emptyState('No deals found', q ? 'Try a different search.' : 'Be the first to post one!', html`<a class="btn btn-primary" href="/submit">Post a deal</a>`),
        );
      }
      moreBox.hidden = !hasMore;
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      loading = false;
    }
  }
  $('button', moreBox).addEventListener('click', load);
  const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && load(), { rootMargin: '600px' });
  io.observe($('#sentinel'));
  pageCleanup = () => io.disconnect();
  await load();
}

// ============================================================ pages: deal detail (§8)

async function detailPage({ params, alive }) {
  const id = params[0];
  const [{ deal: d }, { comments }] = await Promise.all([api(`/api/deals/${id}`), api(`/api/deals/${id}/comments`)]);
  if (!alive()) return;
  const removed = d.status !== 'active';
  setPage(
    d.title,
    html`
      ${removed ? html`<div class="banner removed">This deal was removed by a moderator and is only visible to moderators.</div>` : ''}
      <article class="detail">
        <div class="detail-media"><img src="${d.imageUrl || placeholder(d.store)}" data-label="${d.store}" alt="${d.title}"></div>
        <div>
          <div class="meta-line">
            <strong>${d.store}</strong>
            ${d.category ? html`<a class="badge" href="/deals?category=${d.category.slug}">${d.category.name}</a>` : ''}
          </div>
          <h1>${d.title}</h1>
          <div class="prices" style="gap:12px;align-items:center">
            ${priceBlock(d, { mrpLabel: true })}
            ${d.discountPct ? html`<span class="off-badge">${d.discountPct}% off</span>` : ''}
          </div>
          <div class="actions">
            ${voteWidget(d, { large: true })}
            <a class="btn btn-primary btn-lg" href="${d.sourceUrl}" target="_blank" rel="noopener noreferrer nofollow ugc">Get deal on ${d.store} ↗</a>
          </div>
          <div class="actions" style="margin-top:0">
            ${removed ? '' : html`<button class="btn ${d.bookmarked ? 'on' : ''}" data-action="bookmark" data-id="${d.id}" aria-pressed="${d.bookmarked}">♡ <span class="lbl">${d.bookmarked ? 'Saved' : 'Save'}</span></button>`}
            <button class="btn" data-action="share" data-id="${d.id}" data-title="${d.title}">↗ Share</button>
            ${state.user && !removed && state.user.id !== d.poster.id ? html`<button class="btn" data-action="report" data-type="deal" data-id="${d.id}">⚑ Report</button>` : ''}
            ${d.canEdit ? html`<a class="btn" href="/deals/${d.id}/edit">✎ Edit</a>` : ''}
            ${isMod() ? html`<a class="btn" href="/admin/deals?q=${encodeURIComponent(d.title.slice(0, 40))}">Moderate</a>` : ''}
          </div>
          <p class="meta-line">Posted by <strong>@${d.poster.handle}</strong> · <span title="${fullDate(d.createdAt)}">${timeAgo(d.createdAt)}</span>
            · ${d.upvotes} up / ${d.downvotes} down</p>
          <h2 style="font-size:17px;margin:20px 0 8px">Deal details</h2>
          ${d.details ? html`<p class="details-text">${d.details}</p>` : html`<p class="muted">No additional details provided.</p>`}
        </div>
      </article>
      <section class="comments" id="comments">
        <h2>Comments <span class="muted" id="comment-count">(${comments.length})</span></h2>
        ${
          state.user
            ? removed
              ? ''
              : html`<form class="comment-form" id="comment-form">
                  <div class="form-error" hidden></div>
                  <textarea name="body" maxlength="2000" placeholder="Ask a question or share your experience…" required aria-label="Comment"></textarea>
                  <div style="display:flex;justify-content:flex-end;margin-top:8px"><button class="btn btn-primary">Post comment</button></div>
                </form>`
            : html`<p class="notice info"><a href="/login?next=${encodeURIComponent(location.pathname)}">Sign in</a> to join the conversation.</p>`
        }
        <div id="comment-list">${comments.length ? comments.map(commentItem) : html`<p class="muted" id="no-comments">No comments yet — be the first.</p>`}</div>
      </section>
    `,
  );
  const form = $('#comment-form');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button', form);
    const errBox = $('.form-error', form);
    btn.disabled = true;
    try {
      const { comment } = await api(`/api/deals/${id}/comments`, { method: 'POST', body: { body: form.elements.namedItem('body').value } });
      $('#no-comments')?.remove();
      $('#comment-list').insertAdjacentHTML('beforeend', String(commentItem(comment)));
      const countEl = $('#comment-count');
      countEl.textContent = `(${$$('.comment', $('#comment-list')).length})`;
      form.reset();
      errBox.hidden = true;
    } catch (err) {
      errBox.hidden = false;
      errBox.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

function commentItem(c) {
  const roleBadge = c.author.role !== 'user' ? html`<span class="badge role-${c.author.role}">${c.author.role === 'admin' ? 'Admin' : 'Mod'}</span>` : '';
  const canReport = state.user && state.user.id !== c.author.id;
  return html`<div class="comment">
    <span class="avatar">${c.author.handle[0]}</span>
    <div style="flex:1;min-width:0">
      <div class="comment-head"><strong>@${c.author.handle}</strong>${roleBadge}<span class="muted small" title="${fullDate(c.createdAt)}">${timeAgo(c.createdAt)}</span>
        ${canReport ? html`<button class="linkish" data-action="report" data-type="comment" data-id="${c.id}">Report</button>` : ''}</div>
      <div class="comment-body">${c.body}</div>
    </div>
  </div>`;
}

// ============================================================ pages: submit / edit (§9, §10)

function duplicateNotice(dup) {
  return html`<div class="form-error">This deal has already been posted.
    ${dup?.id ? html`<a href="/deals/${dup.id}">View the existing deal: ${dup.title}</a>` : ''}</div>`;
}

function dealForm(v, { mode, notice = '' }) {
  return html`<form id="deal-form" novalidate>
    ${notice}
    <div id="form-error"></div>
    <div class="url-chip"><span>🔗</span><code>${v.url}</code>
      ${mode === 'create' ? html`<button type="button" class="linkish" id="change-url">Change</button>` : ''}</div>
    ${mode === 'edit' ? html`<div class="field"><label for="f-url">Deal URL</label><input id="f-url" name="url" type="url" value="${v.url}" required></div>` : ''}
    <div class="submit-grid">
      <div>
        <div class="img-preview" id="img-preview">${v.imageUrl ? html`<img src="${v.imageUrl}" data-label="${v.store}" alt="Preview">` : 'No image'}</div>
      </div>
      <div>
        <div class="field"><label for="f-title">Title</label><input id="f-title" name="title" maxlength="200" required value="${v.title || ''}"></div>
        <div class="field"><label for="f-image">Image URL</label><input id="f-image" name="imageUrl" type="url" value="${v.imageUrl || ''}" placeholder="https://…">
          <span class="hint">Auto-filled from the page when possible — paste a different image link to replace it.</span></div>
        <div class="field-row">
          <div class="field"><label for="f-price">Deal price (₹)</label><input id="f-price" name="price" inputmode="decimal" required value="${v.price ?? ''}" placeholder="0 for free"></div>
          <div class="field"><label for="f-full">MRP (₹)</label><input id="f-full" name="fullPrice" inputmode="decimal" value="${v.fullPrice ?? ''}" placeholder="Optional"></div>
        </div>
        <p class="discount-preview" id="discount-preview"></p>
        <div class="field-row">
          <div class="field"><label for="f-store">Store</label><input id="f-store" name="store" maxlength="80" required value="${v.store || ''}"></div>
          <div class="field"><label for="f-cat">Category</label>
            <select id="f-cat" name="categoryId" required>
              <option value="">Choose a category…</option>
              ${state.categories.map((c) => html`<option value="${c.id}" ${Number(v.categoryId) === c.id ? 'selected' : ''}>${c.name}</option>`)}
            </select></div>
        </div>
        <div class="field"><label for="f-details">Deal details</label>
          <textarea id="f-details" name="details" maxlength="5000" placeholder="Coupon code, bank/card offers, expiry, COD or pincode availability, delivery notes…">${v.details || ''}</textarea></div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <a class="btn" href="${mode === 'edit' ? `/deals/${v.id}` : '/'}">Cancel</a>
          <button class="btn btn-primary" id="submit-btn">${mode === 'edit' ? 'Save changes' : 'Post deal'}</button>
        </div>
      </div>
    </div>
  </form>`;
}

function bindDealForm(form, { url, onSubmit }) {
  const preview = $('#img-preview');
  const img = form.imageUrl;
  img.addEventListener('change', () => {
    const val = img.value.trim();
    preview.innerHTML = val ? String(html`<img src="${val}" alt="Preview">`) : 'No image';
  });
  const disc = $('#discount-preview');
  const updateDisc = () => {
    const p = parseMoney(form.price.value);
    const f = parseMoney(form.fullPrice.value);
    disc.textContent = form.price.value && form.fullPrice.value && f > p && p >= 0 ? `${Math.round((1 - p / f) * 100)}% off` : '';
  };
  form.price.addEventListener('input', updateDisc);
  form.fullPrice.addEventListener('input', updateDisc);
  updateDisc();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#submit-btn');
    const errBox = $('#form-error');
    errBox.innerHTML = '';
    const body = Object.fromEntries(new FormData(form));
    body.url = form.url ? form.url.value : url;
    btn.disabled = true;
    try {
      await onSubmit(body);
    } catch (err) {
      errBox.innerHTML = String(err.status === 409 ? duplicateNotice(err.data.duplicate) : html`<div class="form-error">${err.message}</div>`);
      errBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } finally {
      btn.disabled = false;
    }
  });
}

async function submitPage({ query, alive }) {
  if (!state.user) return goLogin();
  const initialUrl = query.get('url') || '';
  const showUrlStep = (value = '', error = '') => {
    setPage(
      'Post a deal',
      html`<div class="page-head"><h1>Post a deal</h1></div>
      <div class="panel">
        <form id="url-form">
          ${error}
          <div class="field"><label for="u-url">Paste the deal link</label>
            <input id="u-url" name="url" type="url" required placeholder="https://www.flipkart.com/… or a Myntra, Amazon, AJIO, Nykaa, Meesho link" value="${value}" autofocus>
            <span class="hint">We'll check it hasn't been posted already and try to fill in the title, image, price, and store for you.</span></div>
          <button class="btn btn-primary" id="url-btn">Continue</button>
        </form>
      </div>`,
    );
    $('#url-form').addEventListener('submit', (e) => {
      e.preventDefault();
      prefill($('#u-url').value.trim());
    });
  };
  const prefill = async (url) => {
    const btn = $('#url-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Fetching details…';
    }
    try {
      const r = await api('/api/deals/prefill', { method: 'POST', body: { url } });
      if (!alive()) return;
      const notice = r.ok ? html`<div class="notice">✓ We filled in what we could find — please double-check everything before posting.</div>` : html`<div class="notice">Couldn't auto-fill details${r.reason ? html` (${r.reason})` : ''} — please complete manually.</div>`;
      const v = { url: r.url, ...r.fields };
      setPage('Post a deal', html`<div class="page-head"><h1>Post a deal</h1></div><div class="panel">${dealForm(v, { mode: 'create', notice })}</div>`);
      $('#change-url').addEventListener('click', () => showUrlStep(r.url));
      bindDealForm($('#deal-form'), {
        url: r.url,
        onSubmit: async (body) => {
          const { deal } = await api('/api/deals', { method: 'POST', body });
          toast('Your deal is live!');
          navigate(`/deals/${deal.id}`, { replace: true });
        },
      });
    } catch (err) {
      if (!alive()) return;
      if (err.status === 401) return goLogin();
      showUrlStep(url, err.status === 409 ? duplicateNotice(err.data.duplicate) : html`<div class="form-error">${err.message}</div>`);
    }
  };
  showUrlStep(initialUrl);
  if (initialUrl) prefill(initialUrl); // e.g. opened from the browser extension
}

async function editPage({ params, alive }) {
  if (!state.user) return goLogin();
  const { deal: d } = await api(`/api/deals/${params[0]}`);
  if (!alive()) return;
  if (!d.canEdit) throw Object.assign(new Error('You can only edit your own active deals.'), { status: 403 });
  const v = { id: d.id, url: d.sourceUrl, title: d.title, imageUrl: d.imageUrl, price: d.price, fullPrice: d.fullPrice, store: d.store, categoryId: d.category?.id, details: d.details };
  setPage('Edit deal', html`<div class="page-head"><h1>Edit deal</h1></div><div class="panel">${dealForm(v, { mode: 'edit' })}</div>`);
  bindDealForm($('#deal-form'), {
    url: d.sourceUrl,
    onSubmit: async (body) => {
      await api(`/api/deals/${d.id}`, { method: 'PATCH', body });
      toast('Deal updated');
      navigate(`/deals/${d.id}`, { replace: true });
    },
  });
}

// ============================================================ pages: wishlist (§13)

async function savedPage({ query, alive }) {
  if (!state.user) return goLogin();
  const tab = query.get('tab') === 'posts' ? 'posts' : 'saved';
  const data = await api(tab === 'posts' ? '/api/me/deals' : '/api/me/bookmarks');
  if (!alive()) return;
  const tabs = html`<nav class="tabs"><a href="/saved" class="${tab === 'saved' ? 'active' : ''}">Wishlisted deals</a><a href="/saved?tab=posts" class="${tab === 'posts' ? 'active' : ''}">My posts</a></nav>`;
  const body = !data.items.length
    ? tab === 'saved'
      ? emptyState('No saved deals yet', 'Tap ♡ Save on any deal to keep it here.', html`<a class="btn" href="/deals">Browse deals</a>`)
      : emptyState("You haven't posted any deals", 'Found a great price? Share it with the community.', html`<a class="btn btn-primary" href="/submit">Post a deal</a>`)
    : html`<div class="grid">${data.items.map((d) =>
        dealCard(d, {
          extra:
            tab === 'saved'
              ? html`<button class="btn btn-sm" style="position:relative;z-index:2;margin-top:8px" data-action="unbookmark" data-id="${d.id}">Remove</button>`
              : d.status !== 'active'
                ? html`<span class="badge status-removed" style="margin-top:8px;align-self:flex-start">Removed by moderator</span>`
                : '',
        }),
      )}</div>`;
  setPage('Saved', html`<div class="page-head"><h1>Your deals</h1></div>${tabs}${body}`);
}

// ============================================================ pages: auth

function nextUrl(query) {
  const n = query.get('next') || '/';
  return n.startsWith('/') && !n.startsWith('//') ? n : '/';
}

async function loginPage({ query }) {
  if (state.user) return navigate(nextUrl(query), { replace: true });
  setPage(
    'Sign in',
    html`<div class="panel narrow"><h1 style="margin-top:0">Sign in</h1>
      <form id="login-form">
        <div class="form-error" hidden></div>
        <div class="field"><label for="l-login">Email or username</label><input id="l-login" name="login" autocomplete="username" required autofocus></div>
        <div class="field"><label for="l-pw">Password</label><input id="l-pw" name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn btn-primary" style="width:100%">Sign in</button>
      </form>
      <p class="muted small" style="text-align:center">New here? <a href="/register?next=${encodeURIComponent(nextUrl(query))}">Create an account</a></p>
      <p class="notice info small">Demo accounts (password <code>password123</code>): <code>admin</code>, <code>mod_priya</code>, <code>rahul</code></p>
    </div>`,
  );
  authForm('#login-form', '/api/auth/login', query);
}

async function registerPage({ query }) {
  if (state.user) return navigate(nextUrl(query), { replace: true });
  setPage(
    'Create account',
    html`<div class="panel narrow"><h1 style="margin-top:0">Create your account</h1>
      <form id="reg-form">
        <div class="form-error" hidden></div>
        <div class="field"><label for="r-email">Email</label><input id="r-email" name="email" type="email" autocomplete="email" required autofocus></div>
        <div class="field"><label for="r-handle">Username</label><input id="r-handle" name="handle" autocomplete="username" required minlength="3" maxlength="24" pattern="[A-Za-z0-9_]+">
          <span class="hint">Shown on your deals and comments. Letters, numbers, underscores.</span></div>
        <div class="field"><label for="r-pw">Password</label><input id="r-pw" name="password" type="password" autocomplete="new-password" required minlength="8"></div>
        <button class="btn btn-primary" style="width:100%">Create account</button>
      </form>
      <p class="muted small" style="text-align:center">Already have an account? <a href="/login?next=${encodeURIComponent(nextUrl(query))}">Sign in</a></p>
    </div>`,
  );
  authForm('#reg-form', '/api/auth/register', query);
}

function authForm(sel, endpoint, query) {
  const form = $(sel);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = $('.form-error', form);
    const btn = $('button', form);
    btn.disabled = true;
    try {
      const { user } = await api(endpoint, { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      state.user = user;
      renderChrome();
      toast(`Welcome, @${user.handle}!`);
      navigate(nextUrl(query), { replace: true });
    } catch (err) {
      errBox.hidden = false;
      errBox.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

// ============================================================ pages: Admin Mode (§15)

const ADMIN_TABS = [
  ['reports', 'Reports', false],
  ['deals', 'Deals', false],
  ['comments', 'Comments', false],
  ['users', 'Users & roles', true],
  ['categories', 'Categories', true],
  ['audit', 'Audit log', false],
];

async function adminPage({ params, query, alive }) {
  if (!state.user) return goLogin();
  if (!isMod()) {
    return setPage('Admin', emptyState('Moderators only', 'Admin Mode is available to Moderators and Admins.', html`<a class="btn" href="/">Back to home</a>`));
  }
  const tab = ADMIN_TABS.some(([k, , adminOnly]) => k === params[0] && (!adminOnly || isAdmin())) ? params[0] : 'reports';
  const summary = await api('/api/admin/summary');
  if (!alive()) return;
  const shell = (content) =>
    setPage(
      'Admin Mode',
      html`<div class="page-head"><h1>Admin Mode</h1><span class="badge role-${state.user.role}">${state.user.role}</span></div>
      <p class="notice admin-mobile-note">Admin Mode is designed for desktop browsers — some tables may be cramped on small screens.</p>
      <div class="admin">
        <nav class="admin-nav" aria-label="Admin sections">
          ${ADMIN_TABS.filter(([, , adminOnly]) => !adminOnly || isAdmin()).map(
            ([k, label]) =>
              html`<a href="/admin/${k}" class="${k === tab ? 'active' : ''}">${label}${k === 'reports' && summary.openReports ? html`<span class="count">${summary.openReports}</span>` : ''}</a>`,
          )}
        </nav>
        <div id="admin-body">${content}</div>
      </div>`,
    );
  const reload = () => renderRoute();
  const handlers = { reports: adminReports, deals: adminDeals, comments: adminComments, users: adminUsers, categories: adminCategories, audit: adminAudit };
  await handlers[tab]({ shell, query, alive, reload, summary });
}

async function modAction(fn, successMsg, reload) {
  try {
    await fn();
    toast(successMsg);
    reload();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function bindAdminActions(root, map) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-adm]');
    if (b && map[b.dataset.adm]) {
      e.preventDefault();
      map[b.dataset.adm](b.dataset);
    }
  });
}

async function removeDeal(id, reload) {
  const reason = await askReason({ title: 'Remove this deal?', confirm: 'Remove deal', danger: true, placeholderText: 'e.g. Expired, spam, misleading price' });
  if (reason === null) return;
  await modAction(() => api(`/api/admin/deals/${id}/remove`, { method: 'POST', body: { reason } }), 'Deal removed', reload);
}

async function removeComment(id, reload) {
  const reason = await askReason({ title: 'Remove this comment?', confirm: 'Remove comment', danger: true, placeholderText: 'e.g. Harassment, spam' });
  if (reason === null) return;
  await modAction(() => api(`/api/admin/comments/${id}/remove`, { method: 'POST', body: { reason } }), 'Comment removed', reload);
}

async function adminReports({ shell, alive, reload, summary }) {
  const { items } = await api('/api/admin/reports');
  if (!alive()) return;
  const stats = html`<div class="stats">
    <div class="stat"><div class="muted small">Open reports</div><div class="n">${summary.openReports}</div></div>
    <div class="stat"><div class="muted small">Active deals</div><div class="n">${summary.activeDeals}</div></div>
    <div class="stat"><div class="muted small">Posted (24h)</div><div class="n">${summary.dealsToday}</div></div>
    <div class="stat"><div class="muted small">Users</div><div class="n">${summary.users}</div></div>
  </div>`;
  const card = (r) => {
    if (r.targetType === 'deal') {
      const d = r.deal;
      return html`<div class="report-card">
        <img class="thumb" src="${d?.imageUrl || placeholder(d?.store)}" data-label="${d?.store || ''}" alt="">
        <div class="grow">
          <div class="small muted">Deal · ${r.count} report${r.count > 1 ? 's' : ''} · last ${timeAgo(r.lastAt)}</div>
          <a class="cell-title" href="/deals/${r.targetId}" target="_blank" rel="noopener">${d?.title || `Deal #${r.targetId}`}</a>
          <div class="small muted">${d ? html`${d.store} · ${money(d.price)} · score ${d.score} · by @${d.poster.handle}` : ''}</div>
          <div class="reasons">${r.reasons.map((x) => html`<span class="badge">${x}</span>`)}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${d?.status === 'active' ? html`<button class="btn btn-sm btn-danger" data-adm="removeDeal" data-id="${r.targetId}">Remove deal</button>` : html`<span class="badge status-removed">Already removed</span>`}
          <button class="btn btn-sm" data-adm="dismiss" data-type="deal" data-id="${r.targetId}">Dismiss</button>
        </div>
      </div>`;
    }
    const c = r.comment;
    return html`<div class="report-card">
      <div class="grow">
        <div class="small muted">Comment by @${c?.author} · ${r.count} report${r.count > 1 ? 's' : ''} · last ${timeAgo(r.lastAt)} · <a href="/deals/${c?.dealId}" target="_blank" rel="noopener">view deal</a></div>
        <div class="quote">${c?.body}</div>
        <div class="reasons">${r.reasons.map((x) => html`<span class="badge">${x}</span>`)}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${c?.status === 'visible' ? html`<button class="btn btn-sm btn-danger" data-adm="removeComment" data-id="${r.targetId}">Remove comment</button>` : html`<span class="badge status-removed">Already removed</span>`}
        <button class="btn btn-sm" data-adm="dismiss" data-type="comment" data-id="${r.targetId}">Dismiss</button>
      </div>
    </div>`;
  };
  shell(html`${stats}<h2 style="margin-top:0;font-size:18px">Flagged content</h2>${items.length ? items.map(card) : emptyState('All clear', 'No open reports right now.')}`);
  bindAdminActions($('#admin-body'), {
    removeDeal: ({ id }) => removeDeal(id, reload),
    removeComment: ({ id }) => removeComment(id, reload),
    dismiss: ({ type, id }) => modAction(() => api('/api/admin/reports/dismiss', { method: 'POST', body: { targetType: type, targetId: Number(id) } }), 'Reports dismissed', reload),
  });
}

function adminToolbar(query, statuses, placeholderText) {
  return html`<form class="toolbar" id="adm-filter">
    <input class="input" name="q" type="search" placeholder="${placeholderText}" value="${query.get('q') || ''}">
    ${statuses ? html`<select class="input" name="status">${statuses.map(([v, l]) => html`<option value="${v}" ${query.get('status') === v || (!query.get('status') && !v) ? 'selected' : ''}>${l}</option>`)}</select>` : ''}
    <button class="btn">Filter</button>
  </form>`;
}

function bindToolbar() {
  const f = $('#adm-filter');
  const go = () => {
    const p = new URLSearchParams();
    for (const [k, v] of new FormData(f)) if (v) p.set(k, v);
    navigate(`${location.pathname}${p.toString() ? `?${p}` : ''}`, { replace: true });
  };
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    go();
  });
  $('select', f)?.addEventListener('change', go);
}

async function adminDeals({ shell, query, alive, reload }) {
  const p = new URLSearchParams({ q: query.get('q') || '', status: query.get('status') || '' });
  const { items } = await api(`/api/admin/deals?${p}`);
  if (!alive()) return;
  shell(html`${adminToolbar(query, [['', 'All statuses'], ['active', 'Active'], ['removed', 'Removed']], 'Search title, store, or poster')}
    <div class="table-wrap"><table>
      <thead><tr><th>Deal</th><th>Store</th><th>Poster</th><th class="num">Score</th><th>Status</th><th>Posted</th><th></th></tr></thead>
      <tbody>${items.map(
        (d) => html`<tr>
          <td><a class="cell-title" href="/deals/${d.id}" target="_blank" rel="noopener">${d.title}</a></td>
          <td>${d.store}</td><td>@${d.poster.handle}</td><td class="num">${d.score}</td>
          <td><span class="badge status-${d.status}">${d.status}</span></td>
          <td title="${fullDate(d.createdAt)}">${timeAgo(d.createdAt)}</td>
          <td class="actions-cell">${
            d.status === 'active'
              ? html`<button class="btn btn-sm btn-danger" data-adm="remove" data-id="${d.id}">Remove</button>`
              : html`<button class="btn btn-sm" data-adm="restore" data-id="${d.id}">Restore</button>`
          }</td>
        </tr>`,
      )}</tbody>
    </table>${items.length ? '' : emptyState('No deals match', '')}</div>`);
  bindToolbar();
  bindAdminActions($('#admin-body'), {
    remove: ({ id }) => removeDeal(id, reload),
    restore: async ({ id }) => {
      const reason = await askReason({ title: 'Restore this deal?', confirm: 'Restore', required: false });
      if (reason !== null) modAction(() => api(`/api/admin/deals/${id}/restore`, { method: 'POST', body: { reason } }), 'Deal restored', reload);
    },
  });
}

async function adminComments({ shell, query, alive, reload }) {
  const p = new URLSearchParams({ q: query.get('q') || '', status: query.get('status') || '' });
  const { items } = await api(`/api/admin/comments?${p}`);
  if (!alive()) return;
  shell(html`${adminToolbar(query, [['', 'All statuses'], ['visible', 'Visible'], ['removed', 'Removed']], 'Search text or author')}
    <div class="table-wrap"><table>
      <thead><tr><th>Comment</th><th>Author</th><th>On deal</th><th>Status</th><th>Posted</th><th></th></tr></thead>
      <tbody>${items.map(
        (c) => html`<tr>
          <td style="max-width:360px"><div class="quote" style="margin:0">${c.body}</div></td>
          <td>@${c.author}</td>
          <td><a class="cell-title" href="/deals/${c.dealId}" target="_blank" rel="noopener">${c.dealTitle}</a></td>
          <td><span class="badge status-${c.status === 'visible' ? 'active' : 'removed'}">${c.status}</span></td>
          <td title="${fullDate(c.createdAt)}">${timeAgo(c.createdAt)}</td>
          <td class="actions-cell">${
            c.status === 'visible'
              ? html`<button class="btn btn-sm btn-danger" data-adm="remove" data-id="${c.id}">Remove</button>`
              : html`<button class="btn btn-sm" data-adm="restore" data-id="${c.id}">Restore</button>`
          }</td>
        </tr>`,
      )}</tbody>
    </table>${items.length ? '' : emptyState('No comments match', '')}</div>`);
  bindToolbar();
  bindAdminActions($('#admin-body'), {
    remove: ({ id }) => removeComment(id, reload),
    restore: ({ id }) => modAction(() => api(`/api/admin/comments/${id}/restore`, { method: 'POST', body: {} }), 'Comment restored', reload),
  });
}

async function adminUsers({ shell, query, alive, reload }) {
  const { items } = await api(`/api/admin/users?${new URLSearchParams({ q: query.get('q') || '' })}`);
  if (!alive()) return;
  const userActions = (u) => {
    if (u.role === 'admin' || u.id === state.user.id) return html`<span class="muted small">—</span>`;
    return html`
      ${u.role === 'user' ? html`<button class="btn btn-sm" data-adm="role" data-id="${u.id}" data-role="moderator" data-handle="${u.handle}">Make moderator</button>` : html`<button class="btn btn-sm" data-adm="role" data-id="${u.id}" data-role="user" data-handle="${u.handle}">Demote to user</button>`}
      ${u.status === 'active' ? html`<button class="btn btn-sm" data-adm="status" data-id="${u.id}" data-status="suspended" data-handle="${u.handle}">Suspend</button>` : html`<button class="btn btn-sm" data-adm="status" data-id="${u.id}" data-status="active" data-handle="${u.handle}">Reinstate</button>`}
      ${u.status !== 'banned' ? html`<button class="btn btn-sm btn-danger" data-adm="status" data-id="${u.id}" data-status="banned" data-handle="${u.handle}">Ban</button>` : ''}`;
  };
  shell(html`${adminToolbar(query, null, 'Search username or email')}
    <div class="table-wrap"><table>
      <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Status</th><th class="num">Deals</th><th class="num">Removed</th><th class="num">Comments</th><th>Joined</th><th></th></tr></thead>
      <tbody>${items.map(
        (u) => html`<tr>
          <td><strong>@${u.handle}</strong></td><td>${u.email}</td>
          <td><span class="badge role-${u.role}">${u.role}</span></td>
          <td><span class="badge status-${u.status}">${u.status}</span></td>
          <td class="num">${u.dealCount}</td><td class="num">${u.removedCount}</td><td class="num">${u.commentCount}</td>
          <td>${new Date(u.createdAt).toLocaleDateString('en-IN')}</td>
          <td class="actions-cell">${userActions(u)}</td>
        </tr>`,
      )}</tbody>
    </table></div>
    <p class="muted small">Suspended users can browse but not post, vote, or comment. Banned users are signed out and cannot sign in.</p>`);
  bindToolbar();
  bindAdminActions($('#admin-body'), {
    role: async ({ id, role, handle }) => {
      const reason = await askReason({ title: role === 'moderator' ? `Promote @${handle} to Moderator?` : `Demote @${handle} to User?`, confirm: role === 'moderator' ? 'Promote' : 'Demote', required: false });
      if (reason !== null) modAction(() => api(`/api/admin/users/${id}/role`, { method: 'POST', body: { role, reason } }), 'Role updated', reload);
    },
    status: async ({ id, status, handle }) => {
      const titles = { suspended: `Suspend @${handle}?`, banned: `Ban @${handle}?`, active: `Reinstate @${handle}?` };
      const reason = await askReason({ title: titles[status], confirm: status === 'active' ? 'Reinstate' : status === 'banned' ? 'Ban user' : 'Suspend', danger: status !== 'active', required: status !== 'active' });
      if (reason !== null) modAction(() => api(`/api/admin/users/${id}/status`, { method: 'POST', body: { status, reason } }), 'Account updated', reload);
    },
  });
}

async function adminCategories({ shell, alive, reload }) {
  const { items } = await api('/api/admin/categories');
  if (!alive()) return;
  shell(html`<form class="toolbar" id="cat-add"><input class="input" name="name" placeholder="New category name" maxlength="40" required><button class="btn btn-primary">Add category</button></form>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th class="num">Active deals</th><th>Status</th><th></th></tr></thead>
      <tbody>${items.map(
        (c) => html`<tr>
          <td><form class="toolbar" style="margin:0" data-rename="${c.id}"><input class="input" name="name" value="${c.name}" maxlength="40" required><button class="btn btn-sm">Rename</button></form></td>
          <td class="num">${c.dealCount}</td>
          <td><span class="badge status-${c.active ? 'active' : 'removed'}">${c.active ? 'Active' : 'Hidden'}</span></td>
          <td class="actions-cell"><button class="btn btn-sm" data-adm="toggle" data-id="${c.id}" data-active="${c.active ? '0' : '1'}">${c.active ? 'Hide' : 'Show'}</button></td>
        </tr>`,
      )}</tbody>
    </table></div>
    <p class="muted small">Hidden categories can't be chosen for new deals; existing deals keep their category.</p>`);
  const refreshMeta = async () => {
    const meta = await api('/api/meta');
    state.categories = meta.categories;
    reload();
  };
  $('#cat-add').addEventListener('submit', (e) => {
    e.preventDefault();
    modAction(() => api('/api/admin/categories', { method: 'POST', body: { name: e.target.elements.namedItem('name').value } }), 'Category added', refreshMeta);
  });
  for (const f of $$('[data-rename]')) {
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      modAction(() => api(`/api/admin/categories/${f.dataset.rename}`, { method: 'PATCH', body: { name: f.elements.namedItem('name').value } }), 'Category renamed', refreshMeta);
    });
  }
  bindAdminActions($('#admin-body'), {
    toggle: ({ id, active }) => modAction(() => api(`/api/admin/categories/${id}`, { method: 'PATCH', body: { active: active === '1' } }), 'Category updated', refreshMeta),
  });
}

async function adminAudit({ shell, query, alive }) {
  const page = Number(query.get('page')) || 1;
  const data = await api(`/api/admin/audit?page=${page}`);
  if (!alive()) return;
  shell(html`<p class="muted">${data.scope === 'all' ? 'All moderation actions across the team.' : 'Moderation actions you have taken.'}</p>
    <div class="table-wrap"><table>
      <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Reason</th></tr></thead>
      <tbody>${data.items.map(
        (a) => html`<tr>
          <td title="${fullDate(a.createdAt)}">${timeAgo(a.createdAt)}</td>
          <td>@${a.actor}</td>
          <td><span class="badge">${a.action.replace(/_/g, ' ')}</span></td>
          <td>${a.targetType} #${a.targetId}${a.targetLabel ? html` · <span class="muted">${a.targetLabel}</span>` : ''}</td>
          <td>${a.reason || html`<span class="muted">—</span>`}</td>
        </tr>`,
      )}</tbody>
    </table>${data.items.length ? '' : emptyState('No actions yet', 'Moderation actions will be logged here.')}</div>
    <div class="load-more">
      ${page > 1 ? html`<a class="btn" href="/admin/audit?page=${page - 1}">← Newer</a>` : ''}
      ${data.hasMore ? html`<a class="btn" href="/admin/audit?page=${page + 1}">Older →</a>` : ''}
    </div>`);
}

// ============================================================ boot

(async function boot() {
  try {
    const meta = await api('/api/meta');
    state.user = meta.user;
    state.categories = meta.categories;
  } catch {
    /* render signed-out */
  }
  renderChrome();
  renderRoute();
})();
