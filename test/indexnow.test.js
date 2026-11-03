import test from 'node:test';
import assert from 'node:assert/strict';
import { INDEXNOW_KEY, createIndexNow } from '../src/indexnow.js';

test('IndexNow: batches changed deal pages into one ping', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  const db = {
    all: async (sql, ...ids) => ids.map((id) => ({ id, title: `Deal ${id} Kettle` })),
    get: async () => ({ deal_id: 7 }),
  };
  const fetchImpl = async (url, opts) => (sent.push({ url, body: JSON.parse(opts.body) }), { ok: true, status: 200 });
  const ix = createIndexNow({ db, baseUrl: 'https://www.sharedeals.in', enabled: true, fetchImpl });

  await ix.afterApi('POST', '/api/deals', {}, { deal: { id: 5 } });
  await ix.afterApi('POST', '/api/admin/deals/6/remove', {}, { ok: true });
  await ix.afterApi('PATCH', '/api/offers/99', {}, {});
  await ix.afterApi('POST', '/api/deals/5/vote', {}, {});
  t.mock.timers.tick(10_000);
  await new Promise((r) => setImmediate(r));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.host, 'www.sharedeals.in');
  assert.equal(sent[0].body.key, INDEXNOW_KEY);
  assert.deepEqual(sent[0].body.urlList.sort(), [
    'https://www.sharedeals.in/deals/5/deal-5-kettle',
    'https://www.sharedeals.in/deals/6/deal-6-kettle',
    'https://www.sharedeals.in/deals/7/deal-7-kettle',
  ]);
});

test('IndexNow: off unless enabled', async () => {
  let called = false;
  const ix = createIndexNow({ db: {}, baseUrl: 'https://x.test', enabled: false, fetchImpl: async () => (called = true) });
  await ix.afterApi('POST', '/api/deals', {}, { deal: { id: 1 } });
  assert.equal(called, false);
});
