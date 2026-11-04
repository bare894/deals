import { generateKeyPairSync } from 'node:crypto';
import { createPush } from '../src/push.js';
import { createRepo } from '../src/repo.js';
import { runAlertJob, matchesPhrase, phraseWords } from '../src/alerts.js';
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

const sentMail = [];
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
    // amzn.in/d/… stands in for an Amazon short link that leads to a product page with the poster's tag.
    resolveUrl: async (u) => (new URL(u).hostname === 'amzn.in' ? new URL('https://www.amazon.in/Glimbo-Toaster/dp/B0SHORT123?tag=poster-21') : u),
    amazonTag: 'test-21',
    mailer: { configured: true, send: async (m) => void sentMail.push(m) },
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

  await t.test('change password: needs the current one, signs out other sessions', async () => {
    const me = client();
    assert.equal((await me.post('/api/auth/register', { email: 'pw@t.test', handle: 'pwuser', password: 'oldpassword1' })).status, 200);
    const other = client();
    assert.equal((await other.post('/api/auth/login', { login: 'pwuser', password: 'oldpassword1' })).status, 200);
    assert.equal((await me.post('/api/me/password', { current: 'wrong', password: 'newpassword1' })).status, 401);
    assert.equal((await me.post('/api/me/password', { current: 'oldpassword1', password: 'short' })).status, 400);
    assert.equal((await me.post('/api/me/password', { current: 'oldpassword1', password: 'newpassword1' })).status, 200);
    assert.equal((await me.get('/api/me/bookmarks')).status, 200, 'this session stays signed in');
    assert.equal((await other.get('/api/me/bookmarks')).status, 401, 'other sessions are signed out');
    assert.equal((await client().post('/api/auth/login', { login: 'pwuser', password: 'oldpassword1' })).status, 401);
    assert.equal((await client().post('/api/auth/login', { login: 'pwuser', password: 'newpassword1' })).status, 200);
  });

  await t.test('similar deals: same category, most shared title words first, at most 10', async () => {
    const mk = async (url, title) => (await poster.post('/api/deals', dealBody(url, { title, confirmNew: true }))).data.deal.id;
    const base = await mk('https://shop.com/sim-1', 'Zorbix Turbo Blender 600W');
    const close = await mk('https://shop.com/sim-2', 'Zorbix Turbo Blender 750W Pro');
    await mk('https://shop.com/sim-3', 'Generic Steel Spoon');
    const { items } = (await anon.get(`/api/deals/${base}/similar`)).data;
    assert.equal(items[0].id, close);
    assert.ok(items.length <= 10);
    assert.ok(!items.some((x) => x.id === base));
  });

  await t.test('forgot password: emailed one-time link sets a new password and signs out everywhere', async () => {
    const me = client();
    assert.equal((await me.post('/api/auth/register', { email: 'forgot@t.test', handle: 'forgetful', password: 'oldpassword1' })).status, 200);
    sentMail.length = 0;
    const unknown = await client().post('/api/auth/forgot', { email: 'nobody@t.test' });
    assert.equal(unknown.status, 200, 'same answer for unknown emails');
    assert.equal(sentMail.length, 0);
    assert.equal((await client().post('/api/auth/forgot', { email: 'Forgot@T.test' })).status, 200);
    assert.equal(sentMail.length, 1);
    assert.equal(sentMail[0].to, 'forgot@t.test');
    const token = sentMail[0].text.match(/reset-password\?token=([\w-]+)/)[1];
    assert.equal((await client().post('/api/auth/reset', { token: 'bogus', password: 'newpassword1' })).status, 400);
    assert.equal((await client().post('/api/auth/reset', { token, password: 'short' })).status, 400);
    assert.equal((await client().post('/api/auth/reset', { token, password: 'newpassword1' })).status, 200);
    assert.equal((await client().post('/api/auth/reset', { token, password: 'another12345' })).status, 400, 'links work once');
    assert.equal((await me.get('/api/me/bookmarks')).status, 401, 'signed out everywhere');
    assert.equal((await client().post('/api/auth/login', { login: 'forgetful', password: 'newpassword1' })).status, 200);
    assert.equal((await client().post('/api/auth/login', { login: 'forgetful', password: 'oldpassword1' })).status, 401);
  });

  await t.test('page views are logged for signed-in users and steer For You', async () => {
    const mk = async (url, title) => (await poster.post('/api/deals', dealBody(url, { title, confirmNew: true }))).data.deal.id;
    const seen = await mk('https://shop.com/pv-1', 'Qwopper Espresso Machine 15 Bar');
    const like = await mk('https://shop.com/pv-2', 'Qwopper Espresso Grinder Pro');
    const viewer = client();
    assert.equal((await viewer.post('/api/auth/register', { email: 'pv@t.test', handle: 'pageviewer', password: 'password123' })).status, 200);
    assert.equal((await anon.post('/api/pageview', { path: `/deals/${seen}` })).status, 200, 'signed-out visits are ignored');
    assert.equal((await viewer.post('/api/pageview', { path: `/deals/${seen}/qwopper-espresso-machine-15-bar` })).status, 200);
    assert.equal((await viewer.post('/api/pageview', { path: '/c/electronics' })).status, 200);
    assert.equal((await viewer.post('/api/pageview', { path: '/admin/deals' })).status, 200);
    const u = await db.get("SELECT id FROM users WHERE handle = 'pageviewer'");
    const rows = await db.all('SELECT path, deal_id, category_id FROM page_views WHERE user_id = ? ORDER BY id', u.id);
    assert.deepEqual(rows.map((r) => r.path), [`/deals/${seen}/qwopper-espresso-machine-15-bar`, '/c/electronics'], 'admin pages are not logged');
    assert.equal(rows[0].deal_id, seen);
    assert.ok(rows[1].category_id);
    const home = (await viewer.get('/api/home')).data;
    assert.equal(home.forYouPersonalized, true);
    assert.equal(home.forYou[0].id, like, 'a deal like the one they viewed comes first');
  });

  await t.test('deal alerts: a new deal that matches an app user\'s views is pushed to their device', async () => {
    const viewer = client();
    assert.equal((await viewer.post('/api/auth/login', { login: 'pageviewer', password: 'password123' })).status, 200);
    assert.equal((await viewer.post('/api/push/token', { token: 'device-token-1' })).status, 200);
    assert.equal((await anon.post('/api/push/token', { token: 'x' })).status, 401);
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const env = { FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'sd-test', client_email: 'push@sd-test.iam', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }) };
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, body: opts.body });
      if (url.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
      return { ok: true, text: async () => '' };
    };
    const push = createPush({ db, repo: createRepo(db), env, fetchImpl, log: { error() {} } });
    assert.equal(push.enabled, true);
    const match = (await poster.post('/api/deals', dealBody('https://shop.com/pv-3', { title: 'Qwopper Espresso Tamper Steel', confirmNew: true }))).data.deal.id;
    assert.equal((await push.notifyNewDeal(match)).sent, 1);
    const fcm = calls.find((c) => c.url.includes('fcm.googleapis.com'));
    const msg = JSON.parse(fcm.body).message;
    assert.equal(msg.token, 'device-token-1');
    assert.equal(msg.data.kind, 'deal_alert');
    assert.match(msg.data.url, new RegExp(`^/deals/${match}/qwopper-espresso-tamper-steel$`));
    const unrelated = (await poster.post('/api/deals', dealBody('https://shop.com/pv-4', { title: 'Zentrix Garden Hose 20m', category: 'Home & Kitchen', confirmNew: true }))).data.deal.id;
    assert.equal((await push.notifyNewDeal(unrelated)).sent, 0, 'no alert for deals outside their interests');
    assert.equal((await viewer.del('/api/push/token', { token: 'device-token-1' })).status, 200);
    assert.equal((await push.notifyNewDeal(match)).sent, 0, 'signed-out devices get nothing');
  });

  await t.test('alerts: add, edit, delete, at most 10, matched hourly and pushed once', async () => {
    const me = client();
    assert.equal((await me.post('/api/auth/register', { email: 'alerts@t.test', handle: 'alerter', password: 'password123' })).status, 200);
    assert.equal((await anon.get('/api/alerts')).status, 401);
    const add = await me.post('/api/alerts', { phrase: '  Glimbo   Kettle ' });
    assert.equal(add.status, 200);
    assert.equal(add.data.alert.phrase, 'Glimbo Kettle');
    assert.equal((await me.post('/api/alerts', { phrase: 'glimbo kettle' })).status, 409, 'no duplicates');
    assert.equal((await me.post('/api/alerts', { phrase: 'x' })).status, 400);
    for (let i = 2; i <= 10; i++) assert.equal((await me.post('/api/alerts', { phrase: `thing ${i}` })).status, 200);
    const eleventh = await me.post('/api/alerts', { phrase: 'one too many' });
    assert.equal(eleventh.status, 400);
    assert.match(eleventh.data.error, /up to 10 alerts/);
    const list = (await me.get('/api/alerts')).data;
    assert.equal(list.items.length, 10);
    assert.equal(list.max, 10);
    const thing2 = list.items.find((a) => a.phrase === 'thing 2');
    assert.equal((await me.patch(`/api/alerts/${thing2.id}`, { phrase: 'Zorpo Lamp' })).status, 200);
    const thing3 = list.items.find((a) => a.phrase === 'thing 3');
    assert.equal((await me.del(`/api/alerts/${thing3.id}`)).status, 200);
    assert.equal((await poster.del(`/api/alerts/${thing2.id}`)).status, 404, "can't touch someone else's alert");
    assert.equal((await me.get('/api/alerts')).data.items.length, 9);

    // The hourly job: matching deals posted after the alert, one push per user, never twice.
    const meRow = await db.get("SELECT id FROM users WHERE handle = 'alerter'");
    const pushes = [];
    const push = { sendToUser: async (userId, message, opts) => (pushes.push({ userId, message, opts }), true) };
    const kettle = (await poster.post('/api/deals', dealBody('https://shop.com/al-1', { title: 'Glimbo Electric Kettle 1.7L', confirmNew: true }))).data.deal.id;
    await poster.post('/api/deals', dealBody('https://shop.com/al-2', { title: 'Unrelated Toaster', confirmNew: true }));
    const r1 = await runAlertJob({ db, repo: createRepo(db), push, log: {} });
    assert.equal(r1.matches, 1);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].userId, meRow.id);
    assert.match(pushes[0].message.title, /Glimbo Kettle/);
    assert.equal(pushes[0].message.data.deal_id, String(kettle));
    assert.equal(pushes[0].message.data.kind, 'search_alert');
    const r2 = await runAlertJob({ db, repo: createRepo(db), push, log: {} });
    assert.equal(r2.matches, 0, 'a deal is announced once per alert');
    assert.equal(pushes.length, 1);
    assert.equal((await me.get('/api/alerts')).data.items.find((a) => a.phrase === 'Glimbo Kettle').matches, 1);
  });

  await t.test('feedback: anyone can send it, moderators read and resolve it', async () => {
    assert.equal((await anon.post('/api/feedback', { message: '' })).status, 400);
    assert.equal((await anon.post('/api/feedback', { message: 'Add Croma please', email: 'nope' })).status, 400);
    assert.equal((await anon.post('/api/feedback', { message: 'Add Croma please', email: 'g@t.test', page: '/deals' })).status, 200);
    assert.equal((await poster.post('/api/feedback', { message: 'Love it', platform: 'android' })).status, 200);
    assert.equal((await poster.get('/api/admin/feedback')).status, 403);
    const list = (await admin.get('/api/admin/feedback?status=new')).data.items;
    const guest = list.find((f) => f.message === 'Add Croma please');
    assert.equal(guest.email, 'g@t.test');
    assert.equal(guest.handle, null);
    assert.equal(list.find((f) => f.message === 'Love it').platform, 'android');
    assert.ok((await admin.get('/api/admin/summary')).data.newFeedback >= 2);
    assert.equal((await admin.post(`/api/admin/feedback/${guest.id}/status`, { status: 'done' })).status, 200);
    assert.ok(!(await admin.get('/api/admin/feedback?status=new')).data.items.some((f) => f.id === guest.id));
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

  await t.test('account deletion: anonymized, personal data gone, votes taken back out of scores', async () => {
    const leaver = client();
    const reg = await leaver.post('/api/auth/register', { email: 'leaver@t.test', handle: 'leaver', password: 'password123' });
    assert.equal(reg.status, 200, JSON.stringify(reg.data));
    const posted = await poster.post('/api/deals', dealBody('https://shop.com/leaver-deal', { title: 'Leaver Test Kettle', confirmNew: true }));
    assert.equal(posted.status, 200, JSON.stringify(posted.data));
    const id = posted.data.deal.id;
    const before = (await anon.get(`/api/deals/${id}`)).data.deal;
    assert.equal((await leaver.post(`/api/deals/${id}/vote`, { value: 1 })).status, 200);
    await leaver.post(`/api/deals/${id}/comments`, { body: 'bye' });
    await leaver.put(`/api/deals/${id}/bookmark`);

    const phrase = 'delete my account';
    assert.equal((await leaver.del('/api/me', { confirm: 'wrong', phrase, password: 'password123' })).status, 400);
    assert.equal((await leaver.del('/api/me', { confirm: 'LEAVER', password: 'password123' })).status, 400, 'phrase required');
    assert.equal((await leaver.del('/api/me', { confirm: 'LEAVER', phrase, password: 'nope' })).status, 401, 'password required');
    assert.equal((await admin.del('/api/me', { confirm: 'admin', phrase })).status, 403, 'admins must be demoted first');
    const del = await leaver.del('/api/me', { confirm: 'LEAVER', phrase, password: 'password123' });
    assert.equal(del.status, 200, JSON.stringify(del.data));

    const after = (await anon.get(`/api/deals/${id}`)).data.deal;
    assert.equal(after.score, before.score, 'their upvote no longer counts');
    const comments = (await anon.get(`/api/deals/${id}/comments`)).data.comments;
    assert.ok(!comments.some((c) => c.body === 'bye'), 'their comments are gone');
    assert.equal((await leaver.get('/api/me/bookmarks')).status, 401, 'signed out everywhere');
    const relogin = await anon.post('/api/auth/login', { login: 'leaver', password: 'password123' });
    assert.equal(relogin.status, 401);
    const row = await db.get("SELECT email, handle, status, password_hash FROM users WHERE email LIKE 'deleted-%'");
    assert.equal(row.status, 'deleted');
    assert.match(row.handle, /^deleted_[0-9a-f]{8}$/);
    assert.equal(row.password_hash, '');
    // The handle and email are free to use again.
    assert.equal((await client().post('/api/auth/register', { email: 'leaver@t.test', handle: 'leaver', password: 'password123' })).status, 200);
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
  assert.match(page, /og:description" content="Big &quot;Sale&quot; &lt;b&gt;now&lt;\/b&gt; for ₹19\.99 \(MRP ₹39\.99, 50% off\) on Shop\./);
  assert.match(page, /<title>Big &quot;Sale&quot; &lt;b&gt;now&lt;\/b&gt; at 50% off on Shop \| ShareDeals<\/title>/);
  assert.match(page, /product:price:currency" content="INR"/);
  const spa = await fetch(`${base}/admin/users`);
  assert.equal(spa.status, 200);
  assert.match(spa.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
});

test('SEO: robots, sitemap, clean URLs, real status codes, structured data', async () => {
  const c = client();
  await c.login('voter');
  const r = await c.post('/api/deals', dealBody('https://seo.com/x', { title: 'Acme Ultra Kettle 1.5L' }));
  const id = r.data.deal.id;
  const get = (p) => fetch(base + p, { redirect: 'manual' });

  const robots = await (await get('/robots.txt')).text();
  assert.match(robots, /Disallow: \/admin/);
  assert.match(robots, /Sitemap: .*\/sitemap\.xml/);
  const sitemap = await (await get('/sitemap.xml')).text();
  assert.match(sitemap, new RegExp(`/deals/${id}/acme-ultra-kettle-1-5l</loc>`));

  const bare = await get(`/deals/${id}`);
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.get('location'), `/deals/${id}/acme-ultra-kettle-1-5l`);
  const page = await (await get(`/deals/${id}/acme-ultra-kettle-1-5l`)).text();
  assert.match(page, /"@type":"Product"/);
  assert.match(page, /"priceCurrency":"INR"/);
  assert.match(page, /<h1>Acme Ultra Kettle 1\.5L<\/h1>/, 'content is in the HTML for crawlers');
  assert.match(page, /<link rel="canonical" href="[^"]*\/deals\/\d+\/acme-ultra-kettle-1-5l">/);

  assert.equal((await get('/deals/999999')).status, 404);
  assert.equal((await get('/no/such/page')).status, 404);
  assert.match(await (await get('/admin')).text(), /noindex/);

  const old = await get('/deals?category=electronics');
  assert.equal(old.status, 301);
  assert.equal(old.headers.get('location'), '/c/electronics');
  const cat = await (await get('/c/electronics')).text();
  assert.match(cat, /<title>Electronics deals today/);
  assert.match(cat, /"@type":"BreadcrumbList"/);
  assert.equal((await get('/c/nope')).status, 404);
  assert.match(await (await get('/')).text(), /"@type":"WebSite"/);
});

test('Amazon short links are stored as the full link and shown with our tag', async () => {
  const poster = client();
  await poster.login('poster');
  const r = await poster.post('/api/deals', dealBody('https://amzn.in/d/abc123', { title: 'Glimbo Toaster Short Link', confirmNew: true }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const [offer] = (await client().get(`/api/deals/${r.data.deal.id}`)).data.deal.offers;
  assert.equal(offer.url, 'https://www.amazon.in/Glimbo-Toaster/dp/B0SHORT123?tag=poster-21');
  assert.equal(offer.buyUrl, 'https://www.amazon.in/dp/B0SHORT123?tag=test-21');
  const other = (await client().get('/api/deals?limit=100')).data;
  for (const d of other.items || other.deals || []) for (const o of d.offers || []) if (!/amazon\.in/.test(o.url)) assert.equal(o.buyUrl, o.url);
});

test('pages on other addresses 301 to PUBLIC_URL; the API stays reachable', async () => {
  const app = createApp({ db, publicDir: path.join(root, 'public'), rateLimits: false, publicUrl: 'https://www.sharedeals.in', canonicalRedirect: true });
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  // fetch() won't send a custom Host header, so use http.request.
  const at = (p, host) =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: srv.address().port, path: p, headers: { host } }, (r) => {
        r.resume();
        resolve({ status: r.statusCode, headers: { get: (k) => r.headers[k] } });
      }).on('error', reject);
    });
  try {
    const r = await at('/deals/5/some-deal?ref=x', 'deals-production-1ecf.up.railway.app');
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), 'https://www.sharedeals.in/deals/5/some-deal?ref=x');
    assert.equal((await at('/', 'sharedeals.in')).headers.get('location'), 'https://www.sharedeals.in/');
    assert.equal((await at('/api/health', 'deals-production-1ecf.up.railway.app')).status, 200);
    assert.equal((await at('/robots.txt', 'www.sharedeals.in')).status, 200);
  } finally {
    srv.close();
  }
});
