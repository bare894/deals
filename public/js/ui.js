// Shared UI: modals, deal card + vote widget, app chrome, and delegated global actions.
import { $, $$, api, fullDate, goLogin, html, isMod, money, navigate, placeholder, state, timeAgo, toast } from './core.js';

// ============================================================ modals

const modal = () => $('#modal');

/** Open a <dialog> containing a <form>; resolves with onSubmit's result, or null if cancelled. */
export function openModal(content, onSubmit) {
  const m = modal();
  m.innerHTML = String(content);
  const form = $('form', m);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      m.close();
      resolve(v);
    };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = $('.form-error', form);
      const btn = $('button:not([data-close])', form);
      if (btn) btn.disabled = true;
      try {
        const v = await onSubmit(new FormData(form));
        done(v ?? true);
      } catch (err) {
        if (errBox) {
          errBox.hidden = false;
          errBox.textContent = err.message;
        }
      } finally {
        if (btn) btn.disabled = false;
      }
    });
    $$('[data-close]', m).forEach((b) => b.addEventListener('click', () => done(null)));
    m.addEventListener('close', () => done(null), { once: true });
    m.showModal();
    $('textarea, input:not([type=radio]):not([type=hidden]), input[type=radio]', form)?.focus();
  });
}

/** Ask for a moderation reason. Resolves to the reason string ('' if optional and empty) or null if cancelled. */
export function askReason({ title, label = 'Reason', confirm = 'Confirm', danger = false, required = true, placeholderText = '' }) {
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
    (fd) => String(fd.get('reason') || '').trim(),
  ).then((v) => (v === null ? null : v === true ? '' : v));
}

const REPORT_REASONS = {
  deal: [['spam', 'Spam or self-promotion'], ['duplicate', 'Duplicate of another deal'], ['wrong_price', 'Wrong product info or misleading'], ['offensive', 'Offensive'], ['other', 'Something else']],
  offer: [['expired', 'Price expired / out of stock'], ['wrong_price', 'Wrong price or wrong product'], ['spam', 'Spam or bad link'], ['other', 'Something else']],
  comment: [['spam', 'Spam'], ['offensive', 'Offensive or abusive'], ['other', 'Something else']],
};
const REPORT_PATH = { deal: 'deals', offer: 'offers', comment: 'comments' };
const REPORT_TITLE = { deal: 'this deal', offer: 'this store listing', comment: 'this comment' };

export function reportModal(type, id) {
  return openModal(
    html`<form>
      <h2>Report ${REPORT_TITLE[type]}</h2>
      <div class="form-error" hidden></div>
      <div class="radio-list">
        ${REPORT_REASONS[type].map(([k, label], i) => html`<label><input type="radio" name="reason" value="${k}" ${i === 0 ? 'checked' : ''}> ${label}</label>`)}
      </div>
      <div class="field"><label for="m-note">Details (optional)</label><input id="m-note" name="note" maxlength="300"></div>
      <div class="modal-actions">
        <button type="button" class="btn" data-close>Cancel</button>
        <button class="btn btn-primary">Send report</button>
      </div>
    </form>`,
    async (fd) => {
      await api(`/api/${REPORT_PATH[type]}/${id}/report`, { method: 'POST', body: { reason: fd.get('reason'), note: fd.get('note') } });
      toast('Thanks — a moderator will take a look.');
    },
  );
}

// ============================================================ components

export function priceBlock(d, { mrpLabel = false } = {}) {
  return html`<div class="prices">
    <span class="price">${money(d.price)}</span>
    ${d.fullPrice ? html`${mrpLabel ? html`<span class="muted small">MRP</span>` : ''}<span class="was">${money(d.fullPrice)}</span>` : ''}
  </div>`;
}

/** "Flipkart" for a single store; "3 stores · lowest at Amazon" when the product is listed in several. */
export function storeLine(d) {
  return d.offerCount > 1 ? html`<span class="stores-count">${d.offerCount} stores</span> · lowest at ${d.store}` : d.store || '';
}

export function voteWidget(d, { large = false } = {}) {
  const mine = d.myVote || 0;
  const own = state.user && d.poster && state.user.id === d.poster.id;
  const dis = own ? html`disabled title="You can't vote on your own deal"` : '';
  return html`<div class="vote ${large ? 'lg' : ''}" data-vote-for="${d.id}" data-my="${mine}">
    <button class="vote-btn up ${mine === 1 ? 'on' : ''}" data-action="vote" data-id="${d.id}" data-value="1" aria-label="Upvote" aria-pressed="${mine === 1}" ${dis}>▲</button>
    <span class="vote-score" aria-label="Net score">${d.score}</span>
    <button class="vote-btn down ${mine === -1 ? 'on' : ''}" data-action="vote" data-id="${d.id}" data-value="-1" aria-label="Downvote" aria-pressed="${mine === -1}" ${dis}>▼</button>
  </div>`;
}

export function dealCard(d, { hot = false, extra = '' } = {}) {
  const removed = d.status !== 'active';
  return html`<article class="card ${removed ? 'is-removed' : ''}">
    ${removed ? '' : html`<a class="card-link" href="/deals/${d.id}" aria-label="${d.title}"></a>`}
    <div class="card-media">
      <img src="${d.imageUrl || placeholder(d.title)}" data-label="${d.title.slice(0, 20)}" alt="" loading="lazy">
      ${d.discountPct ? html`<span class="pill-off">−${d.discountPct}%</span>` : ''}
      ${hot && d.score >= 20 ? html`<span class="pill-hot">🔥 Hot</span>` : ''}
      ${removed ? html`<span class="removed-tag">No longer available</span>` : ''}
    </div>
    <div class="card-body">
      <div class="card-store">${storeLine(d)}</div>
      <h3 class="card-title">${d.title}</h3>
      ${d.price != null ? priceBlock(d) : ''}
      <div class="card-foot">
        ${removed ? '' : voteWidget(d)}
        <span title="Comments">💬 ${d.commentCount}</span>
        <span class="age" title="${fullDate(d.createdAt)}">${timeAgo(d.createdAt)}</span>
      </div>
      ${extra}
    </div>
  </article>`;
}

/** Compact product row used in match suggestions and the moderators' duplicate queue. */
export function miniDeal(d, { href = true } = {}) {
  return html`<div class="mini-deal">
    <img src="${d.imageUrl || placeholder(d.title)}" data-label="${d.title.slice(0, 20)}" alt="">
    <div class="grow">
      ${href ? html`<a class="cell-title" href="/deals/${d.id}" target="_blank" rel="noopener">${d.title}</a>` : html`<strong>${d.title}</strong>`}
      <div class="small muted">#${d.id} · ${d.price != null ? html`${money(d.price)} ` : ''}${storeLine(d)} · score ${d.score} · by @${d.poster.handle}</div>
    </div>
  </div>`;
}

export const skeletonCards = (n) => html`${Array.from({ length: n }, () => html`<div class="skeleton" style="aspect-ratio:3/4"></div>`)}`;

export function updateVoteWidgets(id, myVote, score) {
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

export const actions = {
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
    const on = btn.classList.contains('on');
    try {
      await api(`/api/deals/${btn.dataset.id}/bookmark`, { method: on ? 'DELETE' : 'PUT' });
      btn.classList.toggle('on', !on);
      btn.setAttribute('aria-pressed', !on);
      $('.lbl', btn).textContent = on ? 'Save' : 'Saved';
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
      $('input', modal()).select();
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

export function installGlobalHandlers() {
  document.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (actionEl && actions[actionEl.dataset.action]) {
      e.preventDefault();
      actions[actionEl.dataset.action](actionEl, e);
      return;
    }
    const a = e.target.closest('a[href]');
    if (!a || a.target || a.hasAttribute('download') || a.hasAttribute('data-reload') || a.origin !== location.origin) return;
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(a.pathname + a.search + a.hash);
  });
}

// ============================================================ chrome (header + mobile tab bar)

export function renderChrome() {
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
  markActiveNav(new URL(location.href));
}

export function markActiveNav(url) {
  const p = url.pathname;
  const sort = url.searchParams.get('sort') === 'hot' ? 'hot' : 'new';
  for (const a of $$('[data-nav]')) {
    const target = a.dataset.nav;
    const pathMatch = target === '/' ? p === '/' : target === '/deals' ? p === '/deals' : p.startsWith(target);
    a.classList.toggle('active', pathMatch && (!a.dataset.sort || a.dataset.sort === sort));
  }
  const search = $('#search-form input');
  if (search) search.value = p === '/deals' ? url.searchParams.get('q') || '' : '';
}
