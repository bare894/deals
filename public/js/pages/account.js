// Wishlist (§13), "My posts", sign in, register.
import { $, api, emptyState, goLogin, html, navigate, setPage, state, toast } from '../core.js';
import { dealCard, renderChrome } from '../ui.js';

export async function savedPage({ query, alive }) {
  if (!state.user) return goLogin();
  const tab = query.get('tab') === 'posts' ? 'posts' : 'saved';
  const data = await api(tab === 'posts' ? '/api/me/deals' : '/api/me/bookmarks');
  if (!alive()) return;
  const tabs = html`<nav class="tabs"><a href="/saved" class="${tab === 'saved' ? 'active' : ''}">Wishlisted deals</a><a href="/saved?tab=posts" class="${tab === 'posts' ? 'active' : ''}">My posts &amp; store links</a></nav>`;
  const extra = (d) => {
    if (tab === 'saved') return html`<button class="btn btn-sm" style="position:relative;z-index:2;margin-top:8px" data-action="unbookmark" data-id="${d.id}">Remove</button>`;
    if (d.status !== 'active') return html`<span class="badge status-removed" style="margin-top:8px;align-self:flex-start">Removed by moderator</span>`;
    return html`<span class="badge" style="margin-top:8px;align-self:flex-start">${d.role === 'creator' ? 'You posted this deal' : 'You added a store'}</span>`;
  };
  const body = !data.items.length
    ? tab === 'saved'
      ? emptyState('No saved deals yet', 'Tap ♡ Save on any deal to keep it here.', html`<a class="btn" href="/deals">Browse deals</a>`)
      : emptyState("You haven't posted any deals", 'Found a great price? Share it with the community.', html`<a class="btn btn-primary" href="/submit">Post a deal</a>`)
    : html`<div class="grid">${data.items.map((d) => dealCard(d, { extra: extra(d) }))}</div>`;
  setPage('Saved', html`<div class="page-head"><h1>Your deals</h1></div>${tabs}${body}`);
}

function nextUrl(query) {
  const n = query.get('next') || '/';
  return n.startsWith('/') && !n.startsWith('//') ? n : '/';
}

export async function loginPage({ query }) {
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

export async function registerPage({ query }) {
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
