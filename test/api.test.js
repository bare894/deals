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

before(async () => {
  // In-memory Postgres (PGlite) by default; TEST_DATABASE_URL runs against a real server (wiped first).
  db = await openDb(process.env.TEST_DATABASE_URL || null);
  if (process.env.TEST_DATABASE_URL) await resetDb(db);
  await ensureCategories(db);
  const pw = hashPassword('password123');
  const add = (handle, role) =>
    db.run('INSERT INTO users (email, handle, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)', `${handle}@t.test`, handle, pw, role, Date.now());
  await add('admin', 'admin');
  await add('mod', 'moderator');
  await add('poster', 'user');
  await add('voter', 'user');
  await add('troll', 'user');
  const app = createApp({
    db,
    publicDir: path.join(root, 'public'),
    rateLimits: false,
    approvedStores: null, // the suite posts from stand-in shops; the store allowlist has its own test
    resolveUrl: async (u) => u,
    scraper: async () => ({ ok: true, reason: null, fields: { title: 'Scraped Title', imageUrl: 'https://cdn.x.com/i.jpg', price: 10, fullPrice: 20, store: 'Shop' } }),
  });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await db.close();
});

function client() {
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b = {}, h) => call('POST', p, b, h),
    patch: (p, b = {}) => call('PATCH', p, b),
    put: (p, b = {}) => call('PUT', p, b),
    del: (p, b = {}) => call('DELETE', p, b),
    raw: call,
    login: async (login) => {
      const r = await call('POST', '/api/auth/login', { login, password: 'password123' });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      return r.data.user;
    },
  };
}

const dealBody = (url, extra = {}) => ({ url, title: 'Test Deal Widget', categoryId: 1, price: '19.99', fullPrice: '39.99', store: 'Shop', details: 'Use code X', ...extra });

test('end-to-end: auth, submit, dedup, vote, comment, bookmark, moderation', async (t) => {
  const anon = client();
  const poster = client();
  const voter = client();
  const mod = client();
  const admin = client();
  const troll = client();
  const posterUser = await poster.login('poster');
  await voter.login('voter');
  await mod.login('mod');
  await admin.login('admin@t.test');
  const trollUser = await troll.login('troll');

  let dealId;
  await t.test('submit requires sign-in', async () => {
    assert.equal((await anon.post('/api/deals', dealBody('https://shop.com/p/1'))).status, 401);
  });

  await t.test('submit + prefill', async () => {
    const pre = await poster.post('/api/deals/prefill', { url: 'https://shop.com/p/1?utm_source=x' });
    assert.equal(pre.status, 200);
    assert.equal(pre.data.fields.title, 'Scraped Title');
    // Browser extension: the page snapshot is read first; the server only fetches to fill gaps (here: image).
    const snap = '<meta property="og:title" content="Snapshot Title"><meta property="product:price:amount" content="499"><span>M.R.P.: ₹999</span>';
    const fromExt = await poster.post('/api/deals/prefill', { url: 'https://shop.com/p/ext', html: snap });
    assert.equal(fromExt.status, 200);
    assert.deepEqual([fromExt.data.fields.title, fromExt.data.fields.price, fromExt.data.fields.fullPrice], ['Snapshot Title', 499, 999]);
    assert.equal(fromExt.data.fields.imageUrl, 'https://cdn.x.com/i.jpg'); // gap filled from the fetched page
    const r = await poster.post('/api/deals', dealBody('https://shop.com/p/1?utm_source=x'));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    dealId = r.data.deal.id;
    assert.equal(r.data.deal.discountPct, 50);
    assert.equal(r.data.deal.price, 19.99);
    // Rupee input formats, including lakh grouping.
    const inr = await poster.post('/api/deals', dealBody('https://shop.com/inr', { price: '₹1,29,999', fullPrice: 'Rs. 1,49,900' }));
    assert.equal(inr.status, 200, JSON.stringify(inr.data));
    assert.deepEqual([inr.data.deal.price, inr.data.deal.fullPrice], [129999, 149900]);
  });

  await t.test('validation errors', async () => {
    assert.equal((await poster.post('/api/deals', dealBody('https://shop.com/v', { categoryId: 999 }))).status, 400);
    assert.equal((await poster.post('/api/deals', dealBody('https://shop.com/v', { price: '-1' }))).status, 400);
    assert.equal((await poster.post('/api/deals', dealBody('https://shop.com/v', { fullPrice: '5' }))).status, 400);
    assert.equal((await poster.post('/api/deals', dealBody('javascript:alert(1)'))).status, 400);
    assert.equal((await poster.post('/api/deals', dealBody('https://shop.com/v', { imageUrl: 'javascript:alert(1)' }))).status, 400);
  });

  await t.test('duplicate URL (with tracking noise) is blocked with a link to the existing deal', async () => {
    for (const url of ['http://www.shop.com/p/1/', 'https://shop.com/p/1?ref=abc&gclid=1#x']) {
      const r = await voter.post('/api/deals', dealBody(url));
      assert.equal(r.status, 409);
      assert.equal(r.data.duplicate.id, dealId);
      assert.equal((await voter.post('/api/deals/prefill', { url })).status, 409);
    }
  });

  await t.test('concurrent duplicate submits: exactly one wins (DB unique index)', async () => {
    const results = await Promise.all([poster.post('/api/deals', dealBody('https://race.com/x')), voter.post('/api/deals', dealBody('https://race.com/x'))]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  });

  await t.test('listing + detail are public', async () => {
    const list = await anon.get('/api/deals');
    assert.ok(list.data.items.some((d) => d.id === dealId));
    const detail = await anon.get(`/api/deals/${dealId}`);
    assert.equal(detail.data.deal.details, 'Use code X');
    assert.equal(detail.data.deal.canEdit, false);
    const home = await anon.get('/api/home');
    assert.equal(home.data.forYouPersonalized, false);
    assert.ok(Array.isArray(home.data.latest));
  });

  await t.test('voting rules', async () => {
    assert.equal((await anon.post(`/api/deals/${dealId}/vote`, { value: 1 })).status, 401);
    assert.equal((await poster.post(`/api/deals/${dealId}/vote`, { value: 1 })).status, 403, 'self-vote blocked');
    let r = await voter.post(`/api/deals/${dealId}/vote`, { value: 1 });
    assert.deepEqual([r.data.myVote, r.data.score], [1, 1]);
    r = await voter.post(`/api/deals/${dealId}/vote`, { value: 1 });
    assert.equal(r.data.score, 1, 'idempotent');
    r = await voter.post(`/api/deals/${dealId}/vote`, { value: -1 });
    assert.deepEqual([r.data.score, r.data.upvotes, r.data.downvotes], [-1, 0, 1]);
    r = await voter.post(`/api/deals/${dealId}/vote`, { value: 0 });
    assert.equal(r.data.score, 0);
    await voter.post(`/api/deals/${dealId}/vote`, { value: 1 });
    assert.equal((await voter.get(`/api/deals/${dealId}`)).data.deal.myVote, 1);
    assert.equal((await voter.post(`/api/deals/${dealId}/vote`, { value: 5 })).status, 400);
  });

  await t.test('comments: public read, signed-in write', async () => {
    assert.equal((await anon.post(`/api/deals/${dealId}/comments`, { body: 'hi' })).status, 401);
    const c = await troll.post(`/api/deals/${dealId}/comments`, { body: '<script>alert(1)</script> buy elsewhere' });
    assert.equal(c.status, 200);
    const list = await anon.get(`/api/deals/${dealId}/comments`);
    assert.equal(list.data.comments.length, 1);
    assert.equal((await voter.post(`/api/comments/${c.data.comment.id}/report`, { reason: 'spam' })).status, 200);
    assert.equal((await voter.post(`/api/comments/${c.data.comment.id}/report`, { reason: 'bogus' })).status, 400);
  });

  await t.test('only the poster can edit', async () => {
    assert.equal((await voter.patch(`/api/deals/${dealId}`, dealBody('https://shop.com/p/1'))).status, 403);
    const r = await poster.patch(`/api/deals/${dealId}`, dealBody('https://shop.com/p/1', { title: 'Edited title' }));
    assert.equal(r.status, 200);
    assert.equal(r.data.deal.title, 'Edited title');
  });

  await t.test('bookmarks + for-you personalization', async () => {
    assert.equal((await voter.put(`/api/deals/${dealId}/bookmark`)).status, 200);
    assert.equal((await voter.get('/api/me/bookmarks')).data.items.length, 1);
    assert.equal((await voter.get('/api/home')).data.forYouPersonalized, true);
  });

  await t.test('role enforcement is server-side', async () => {
    for (const [method, p] of [['GET', '/api/admin/reports'], ['POST', `/api/admin/deals/${dealId}/remove`], ['GET', '/api/admin/audit']]) {
      assert.equal((await voter.raw(method, p, method === 'GET' ? undefined : { reason: 'x' })).status, 403, p);
    }
    assert.equal((await anon.get('/api/admin/reports')).status, 401);
    // Moderators can't manage users or categories (Admin only).
    assert.equal((await mod.get('/api/admin/users')).status, 403);
    assert.equal((await mod.post(`/api/admin/users/${trollUser.id}/role`, { role: 'moderator' })).status, 403);
    assert.equal((await mod.post('/api/admin/categories', { name: 'Pets' })).status, 403);
  });

  await t.test('moderator flow: report queue, remove deal, audit', async () => {
    assert.equal((await troll.post(`/api/deals/${dealId}/report`, { reason: 'expired', note: 'gone' })).status, 200);
    const q = await mod.get('/api/admin/reports');
    assert.ok(q.data.items.some((i) => i.targetType === 'deal' && i.targetId === dealId));
    assert.equal((await mod.post(`/api/admin/deals/${dealId}/remove`, {})).status, 400, 'reason required');
    assert.equal((await mod.post(`/api/admin/deals/${dealId}/remove`, { reason: 'expired' })).status, 200);
    assert.equal((await anon.get(`/api/deals/${dealId}`)).status, 404);
    assert.equal((await mod.get(`/api/deals/${dealId}`)).status, 200, 'mods can still view removed deals');
    assert.ok(!(await anon.get('/api/deals')).data.items.some((d) => d.id === dealId));
    const q2 = await mod.get('/api/admin/reports');
    assert.ok(!q2.data.items.some((i) => i.targetType === 'deal' && i.targetId === dealId), 'reports resolved');
    // Wishlist keeps it as "No longer available".
    const saved = (await voter.get('/api/me/bookmarks')).data.items;
    assert.equal(saved[0].status, 'removed');
    // Votes on removed deal rejected.
    assert.equal((await voter.post(`/api/deals/${dealId}/vote`, { value: -1 })).status, 404);
    const audit = await mod.get('/api/admin/audit');
    assert.equal(audit.data.scope, 'own');
    assert.equal(audit.data.items[0].action, 'remove');
  });

  await t.test('removed URL becomes re-postable; restoring the original then conflicts', async () => {
    const r = await voter.post('/api/deals', dealBody('https://shop.com/p/1'));
    assert.equal(r.status, 200);
    const restore = await mod.post(`/api/admin/deals/${dealId}/restore`, {});
    assert.equal(restore.status, 409);
  });

  await t.test('admin: promote, suspend, ban', async () => {
    assert.equal((await admin.post(`/api/admin/users/${trollUser.id}/role`, { role: 'admin' })).status, 400, 'cannot mint admins');
    assert.equal((await admin.post(`/api/admin/users/${trollUser.id}/status`, { status: 'suspended', reason: 'spam' })).status, 200);
    const list = await troll.get('/api/deals');
    assert.equal(list.status, 200, 'suspended users can browse');
    assert.equal((await troll.post(`/api/deals/${dealId}/comments`, { body: 'x' })).status, 403);
    assert.equal((await troll.post('/api/deals', dealBody('https://troll.com/x'))).status, 403);
    assert.equal((await admin.post(`/api/admin/users/${trollUser.id}/status`, { status: 'banned', reason: 'repeat' })).status, 200);
    assert.equal((await troll.get('/api/meta')).data.user, null, 'ban kills sessions');
    assert.equal((await client().post('/api/auth/login', { login: 'troll', password: 'password123' })).status, 403);
    // Promote poster → moderator; they can now moderate.
    assert.equal((await admin.post(`/api/admin/users/${posterUser.id}/role`, { role: 'moderator' })).status, 200);
    assert.equal((await poster.get('/api/admin/reports')).status, 200);
    const audit = await admin.get('/api/admin/audit');
    assert.equal(audit.data.scope, 'all');
    assert.ok(audit.data.items.some((a) => a.action === 'promote_moderator'));
    assert.ok(audit.data.items.some((a) => a.actor === 'mod'), 'admin sees other moderators’ actions');
  });

  await t.test('categories: admin can add + hide', async () => {
    const c = await admin.post('/api/admin/categories', { name: 'Pets' });
    assert.equal(c.status, 200);
    assert.ok((await anon.get('/api/meta')).data.categories.some((x) => x.name === 'Pets'));
    await admin.patch(`/api/admin/categories/${c.data.id}`, { active: false });
    assert.ok(!(await anon.get('/api/meta')).data.categories.some((x) => x.name === 'Pets'));
    assert.equal((await voter.post('/api/deals', dealBody('https://pets.com/x', { categoryId: c.data.id }))).status, 400);
  });
});

test('CSRF defenses on mutating requests', async () => {
  const c = client();
  await c.login('voter');
  const form = await c.raw('POST', '/api/auth/logout', undefined, { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(form.status, 415);
  const cross = await c.raw('POST', '/api/auth/logout', {}, { origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
});

test('deal pages render escaped Open Graph tags; SPA fallback works', async () => {
  const c = client();
  await c.login('voter');
  const r = await c.post('/api/deals', dealBody('https://og.com/x', { title: 'Big "Sale" <b>now</b>' }));
  const page = await fetch(`${base}/deals/${r.data.deal.id}`).then((res) => res.text());
  assert.match(page, /<meta property="og:title" content="Big &quot;Sale&quot; &lt;b&gt;now&lt;\/b&gt;">/);
  assert.match(page, /og:description" content="₹19\.99 \(MRP ₹39\.99, 50% off\) on Shop/);
  assert.match(page, /product:price:currency" content="INR"/);
  const spa = await fetch(`${base}/admin/users`);
  assert.equal(spa.status, 200);
  assert.match(spa.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
});
