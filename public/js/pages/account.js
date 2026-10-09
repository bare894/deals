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

const OAUTH_ERRORS = {
  cancelled: 'Sign-in was cancelled.',
  expired: 'Your sign-in attempt expired. Please try again.',
  no_email: "We couldn't get an email address from that account. Allow email access, or sign up with email below.",
  unverified: "That account's email address isn't verified yet. Verify it with the provider, or sign up with email.",
  banned: 'This account has been banned.',
  unavailable: "That sign-in option isn't available right now.",
  rate_limited: 'Too many attempts. Please wait a few minutes and try again.',
  failed: 'Something went wrong signing you in. Please try again.',
};

/** "Continue with Google / Facebook" buttons for whichever providers the server has configured. */
function socialAuth(query, verb) {
  const providers = state.oauth || [];
  if (!providers.length) return '';
  const next = encodeURIComponent(nextUrl(query));
  return html`<div class="social-auth">
      ${providers.includes('google')
        ? html`<a class="btn btn-social btn-google" href="/auth/google/start?next=${next}" data-reload><svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>${verb} with Google</a>`
        : ''}
      ${providers.includes('facebook')
        ? html`<a class="btn btn-social btn-facebook" href="/auth/facebook/start?next=${next}" data-reload><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M24 12.07C24 5.41 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.26h3.33l-.53 3.49h-2.8V24C19.62 23.1 24 18.1 24 12.07z"/></svg>${verb} with Facebook</a>`
        : ''}
    </div>
    <div class="or-divider"><span>or use email</span></div>`;
}

function showOAuthError(form, query) {
  const msg = OAUTH_ERRORS[query.get('error')];
  if (!msg) return;
  const box = $('.form-error', form);
  box.textContent = msg;
  box.hidden = false;
}

export async function loginPage({ query }) {
  if (state.user) return navigate(nextUrl(query), { replace: true });
  setPage(
    'Sign in',
    html`<div class="panel narrow"><h1 style="margin-top:0">Sign in</h1>
      ${socialAuth(query, 'Continue')}
      <form id="login-form">
        <div class="form-error" hidden></div>
        <div class="field"><label for="l-login">Email or username</label><input id="l-login" name="login" autocomplete="username" required autofocus></div>
        <div class="field"><label for="l-pw">Password</label><input id="l-pw" name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn btn-primary" style="width:100%">Sign in</button>
      </form>
      <p class="muted small" style="text-align:center">New here? <a href="/register?next=${encodeURIComponent(nextUrl(query))}">Create an account</a></p>
      ${state.demo ? html`<p class="notice info small">Demo accounts (password <code>password123</code>): <code>admin</code>, <code>mod_priya</code>, <code>rahul</code></p>` : ''}
    </div>`,
  );
  authForm('#login-form', '/api/auth/login', query);
  showOAuthError($('#login-form'), query);
}

export async function registerPage({ query }) {
  if (state.user) return navigate(nextUrl(query), { replace: true });
  setPage(
    'Create account',
    html`<div class="panel narrow"><h1 style="margin-top:0">Create your account</h1>
      ${socialAuth(query, 'Sign up')}
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
