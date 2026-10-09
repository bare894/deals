import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, ensureCategories } from '../src/db.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let server;
let base;
let db;
// What the fake provider returns for the next sign-in.
let profiles;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function fakeFetch(url) {
  const u = String(url);
  if (u.startsWith('https://oauth2.googleapis.com/token') || u.includes('/oauth/access_token')) return json({ access_token: 'tok' });
  if (u.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) return json(profiles.google);
  if (u.includes('graph.facebook.com/v21.0/me')) return json(profiles.facebook);
  return json({ error: 'unexpected' }, 400);
}

before(async () => {
  db = openDb(':memory:');
  ensureCategories(db);
  db.prepare('INSERT INTO users (email, handle, password_hash, created_at) VALUES (?, ?, ?, ?)').run('existing@t.test', 'existing', hashPassword('password123'), Date.now());
  const app = createApp({
    db,
    publicDir: path.join(root, 'public'),
    rateLimits: false,
    oauth: { google: { clientId: 'gid', clientSecret: 'gsecret' }, facebook: { clientId: 'fid', clientSecret: 'fsecret' } },
    oauthFetch: fakeFetch,
  });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

/** Runs start → (provider) → callback like a browser would; returns the final redirect + session cookie. */
async function signIn(provider, { next = '/saved', tamperState = false } = {}) {
  const start = await fetch(`${base}/auth/${provider}/start?next=${encodeURIComponent(next)}`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get('location'));
  assert.equal(to.searchParams.get('redirect_uri'), `${base}/auth/${provider}/callback`);
  const stateCookie = start.headers.get('set-cookie').split(';')[0];
  const state = tamperState ? 'forged' : to.searchParams.get('state');
  const cb = await fetch(`${base}/auth/${provider}/callback?code=abc&state=${state}`, { redirect: 'manual', headers: { cookie: stateCookie } });
  const sid = cb.headers.getSetCookie().find((c) => c.startsWith('sid=') && !c.startsWith('sid=;'));
  return { location: cb.headers.get('location'), cookie: sid?.split(';')[0] };
}

const me = async (cookie) => (await (await fetch(`${base}/api/meta`, { headers: { cookie } })).json()).user;

test('meta lists configured providers', async () => {
  const meta = await (await fetch(`${base}/api/meta`)).json();
  assert.deepEqual(meta.oauth, ['google', 'facebook']);
});

test('Google sign-in creates an account, then signs back into the same one', async () => {
  profiles = { google: { sub: 'g-1', email: 'Priya.Sharma@gmail.com', email_verified: true, name: 'Priya Sharma' } };
  const first = await signIn('google');
  assert.equal(first.location, '/saved');
  const user = await me(first.cookie);
  assert.equal(user.handle, 'priya_sharma');

  profiles.google.email = 'changed@gmail.com'; // the provider's user id, not the email, identifies the link
  const again = await signIn('google');
  assert.equal((await me(again.cookie)).id, user.id);
});

test('social sign-in links to an existing account with the same verified email', async () => {
  profiles = { facebook: { id: 'fb-9', email: 'existing@t.test', name: 'Someone Else' } };
  const r = await signIn('facebook');
  assert.equal((await me(r.cookie)).handle, 'existing');
});

test('handles collide → suffix; unverified or missing emails are refused', async () => {
  profiles = { google: { sub: 'g-2', email: 'other@gmail.com', email_verified: true, name: 'Priya Sharma' } };
  const h = (await me((await signIn('google')).cookie)).handle;
  assert.match(h, /^priya_sharma\d+$/);

  profiles = { google: { sub: 'g-3', email: 'existing@t.test', email_verified: false, name: 'X' } };
  assert.equal((await signIn('google')).location, '/login?error=unverified');
  profiles = { facebook: { id: 'fb-10', name: 'No Email' } };
  assert.equal((await signIn('facebook')).location, '/login?error=no_email');
});

test('forged state and open redirects are rejected; banned users cannot sign in', async () => {
  profiles = { google: { sub: 'g-1', email: 'x@gmail.com', email_verified: true } };
  const forged = await signIn('google', { tamperState: true });
  assert.equal(forged.location, '/login?error=expired');
  assert.equal(forged.cookie, undefined);

  assert.equal((await signIn('google', { next: '//evil.example' })).location, '/');

  db.prepare("UPDATE users SET status = 'banned' WHERE handle = 'priya_sharma'").run();
  assert.equal((await signIn('google')).location, '/login?error=banned');
});

test('unconfigured providers are unavailable; password login still refuses social-only accounts', async () => {
  const r = await fetch(`${base}/auth/twitter/start`, { redirect: 'manual' });
  assert.equal(r.headers.get('location'), '/login?error=unavailable');
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'other@gmail.com', password: '' }),
  });
  assert.equal(login.status, 401);
});
