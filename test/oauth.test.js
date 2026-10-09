import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, ensureCategories, resetDb } from '../src/db.js';
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
  // In-memory Postgres (PGlite) by default; TEST_DATABASE_URL runs against a real server (wiped first).
  db = await openDb(process.env.TEST_DATABASE_URL || null);
  if (process.env.TEST_DATABASE_URL) await resetDb(db);
  await ensureCategories(db);
  await db.run('INSERT INTO users (email, handle, password_hash, created_at) VALUES (?, ?, ?, ?)', 'existing@t.test', 'existing', hashPassword('password123'), Date.now());
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

after(async () => {
  server.close();
  await db.close();
});

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

  await db.run("UPDATE users SET status = 'banned' WHERE handle = 'priya_sharma'");
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

test('Android app sign-in: one-time code via the app scheme, redeemable once with the verifier', async () => {
  const { createHash, randomBytes } = await import('node:crypto');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  profiles = { google: { sub: 'g-app', email: 'app.user@gmail.com', email_verified: true, name: 'App User' } };

  const start = await fetch(`${base}/auth/google/start?next=%2Fsaved&app=1&challenge=${challenge}`, { redirect: 'manual' });
  const to = new URL(start.headers.get('location'));
  const stateCookie = start.headers.get('set-cookie').split(';')[0];
  const cb = await fetch(`${base}/auth/google/callback?code=abc&state=${to.searchParams.get('state')}`, { redirect: 'manual', headers: { cookie: stateCookie } });
  assert.equal(cb.status, 200);
  assert.ok(!cb.headers.getSetCookie().some((c) => c.startsWith('sid=') && !c.startsWith('sid=;')), 'no session in the browser tab');
  const page = await cb.text();
  const code = page.match(/in\.sharedeals\.app:\/\/auth\?code=([\w-]+)/)?.[1];
  assert.ok(code, 'page hands a code back to the app');

  const finish = (v) => fetch(`${base}/auth/app/finish?code=${code}&verifier=${v}`, { redirect: 'manual' });
  assert.equal((await finish('wrong-verifier')).headers.get('location'), '/login?error=expired'); // also burns the code
  // A fresh code, redeemed properly.
  const cb2 = await fetch(`${base}/auth/google/callback?code=abc&state=${to.searchParams.get('state')}`, { redirect: 'manual', headers: { cookie: stateCookie } });
  const code2 = (await cb2.text()).match(/code=([\w-]+)/)[1];
  const ok = await fetch(`${base}/auth/app/finish?code=${code2}&verifier=${verifier}`, { redirect: 'manual' });
  assert.equal(ok.headers.get('location'), '/saved');
  const sid = ok.headers.getSetCookie().find((c) => c.startsWith('sid='))?.split(';')[0];
  assert.equal((await me(sid)).handle, 'app_user');
  const again = await fetch(`${base}/auth/app/finish?code=${code2}&verifier=${verifier}`, { redirect: 'manual' });
  assert.equal(again.headers.get('location'), '/login?error=expired', 'codes are single-use');

  // Failures go back to the app, not the website's login page.
  profiles = { facebook: { id: 'fb-app', name: 'No Email' } };
  const s3 = await fetch(`${base}/auth/facebook/start?app=1&challenge=${challenge}`, { redirect: 'manual' });
  const c3 = await fetch(`${base}/auth/facebook/callback?code=x&state=${new URL(s3.headers.get('location')).searchParams.get('state')}`, {
    redirect: 'manual', headers: { cookie: s3.headers.get('set-cookie').split(';')[0] },
  });
  assert.match(await c3.text(), /in\.sharedeals\.app:\/\/auth\?error=no_email/);
});

test('assetlinks.json lists the app signing certificates from ANDROID_CERT_SHA256', async () => {
  delete process.env.ANDROID_CERT_SHA256;
  assert.deepEqual(await (await fetch(`${base}/.well-known/assetlinks.json`)).json(), []);
  process.env.ANDROID_CERT_SHA256 = 'aa:bb:cc, DD:EE:FF';
  const [statement] = await (await fetch(`${base}/.well-known/assetlinks.json`)).json();
  assert.equal(statement.target.package_name, 'in.sharedeals.app');
  assert.deepEqual(statement.target.sha256_cert_fingerprints, ['AA:BB:CC', 'DD:EE:FF']);
  delete process.env.ANDROID_CERT_SHA256;
});
