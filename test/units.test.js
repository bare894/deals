import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeUrl, parseDealUrl } from '../src/canonicalize.js';
import { extractDealFields, isPrivateIp, parsePrice, storeFromHost, autoPopulate } from '../src/scrape.js';
import { hotScore, rankHot, rankForYou, categoryAffinity } from '../src/ranking.js';

test('canonicalization strips tracking noise but keeps product identity', () => {
  const base = 'https://bestbuy.com/site/sony-wh1000xm5/6505727.p?skuId=6505727';
  for (const variant of [
    'http://www.bestbuy.com/site/sony-wh1000xm5/6505727.p?skuId=6505727',
    'https://WWW.BestBuy.com/site/sony-wh1000xm5/6505727.p/?skuId=6505727#reviews',
    'https://www.bestbuy.com/site/sony-wh1000xm5/6505727.p?utm_source=x&skuId=6505727&utm_medium=y&ref=abc&gclid=123',
    'www.bestbuy.com/site/sony-wh1000xm5/6505727.p?skuId=6505727',
  ]) {
    assert.equal(canonicalizeUrl(variant), base, variant);
  }
  // Different product params must NOT collapse.
  assert.notEqual(canonicalizeUrl('https://shop.com/p?id=1'), canonicalizeUrl('https://shop.com/p?id=2'));
  // Param order doesn't matter.
  assert.equal(canonicalizeUrl('https://shop.com/p?b=2&a=1'), canonicalizeUrl('https://shop.com/p?a=1&b=2'));
});

test('amazon URLs collapse to /dp/ASIN', () => {
  const want = 'https://amazon.com/dp/B0BX2L8PBT';
  assert.equal(canonicalizeUrl('https://www.amazon.com/Apple-AirPods-Pro/dp/B0BX2L8PBT/ref=sr_1_3?keywords=airpods&qid=1&sr=8-3'), want);
  assert.equal(canonicalizeUrl('https://smile.amazon.com/gp/product/b0bx2l8pbt?tag=aff-20'), want);
});

test('parseDealUrl rejects non-http schemes and junk', () => {
  assert.throws(() => parseDealUrl('javascript:alert(1)'));
  assert.throws(() => parseDealUrl('ftp://example.com/x'));
  assert.throws(() => parseDealUrl('not a url'));
  assert.throws(() => parseDealUrl(''));
});

test('extracts fields from JSON-LD Product + OG tags', () => {
  const html = `<html><head>
    <meta property="og:site_name" content="Gadget Hut">
    <meta property="og:image" content="/img/main.jpg">
    <title>Fallback &amp; title</title>
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},
      {"@type":"Product","name":"Super Widget 3000","image":["https://cdn.example.com/w.jpg"],
       "offers":{"@type":"Offer","price":"1,299.99","priceSpecification":[{"@type":"UnitPriceSpecification","priceType":"https://schema.org/ListPrice","price":1599.99}]}}]}</script>
  </head></html>`;
  const f = extractDealFields(html, 'https://shop.example.com/p/1');
  assert.equal(f.title, 'Super Widget 3000');
  assert.equal(f.imageUrl, 'https://cdn.example.com/w.jpg');
  assert.equal(f.price, 1299.99);
  assert.equal(f.fullPrice, 1599.99);
  assert.equal(f.store, 'Gadget Hut');
});

test('falls back to OG/meta and <title>, resolves relative images', () => {
  const html = `<meta content="Cool Lamp" property="og:title"><meta property="og:image" content="/a.png"><meta property="product:price:amount" content="19.5">`;
  const f = extractDealFields(html, 'https://www.target.com/p/lamp');
  assert.equal(f.title, 'Cool Lamp');
  assert.equal(f.imageUrl, 'https://www.target.com/a.png');
  assert.equal(f.price, 19.5);
  assert.equal(f.store, 'Target');
  assert.equal(extractDealFields('<title> Plain   Page </title>', 'https://x.com').title, 'Plain Page');
});

test('autoPopulate degrades gracefully when the fetch fails (PRD §9.1)', async () => {
  const r = await autoPopulate('https://www.walmart.com/ip/123', async () => {
    throw Object.assign(new Error('nope'), { code: 'ECONNRESET' });
  });
  assert.equal(r.ok, false);
  assert.equal(r.fields.store, 'Walmart');
  assert.equal(r.fields.title, '');
  const blocked = await autoPopulate('https://x.com', async () => ({ status: 403, headers: {}, body: '' }));
  assert.equal(blocked.ok, false);
});

test('SSRF guard classifies internal addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.4', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '100.64.0.1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '151.101.1.69', '172.32.0.1', '2606:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
});

test('price parsing and store naming', () => {
  assert.equal(parsePrice('$1,234.56'), 1234.56);
  assert.equal(parsePrice('USD 49'), 49);
  assert.equal(parsePrice(''), null);
  assert.equal(storeFromHost('www.homedepot.com'), 'The Home Depot');
  assert.equal(storeFromHost('shop.acme.co'), 'Acme');
});

test('hot ranking decays with age', () => {
  const now = Date.now();
  const H = 3_600_000;
  assert.ok(hotScore(50, now - 2 * H, now) > hotScore(50, now - 48 * H, now));
  const old = { score: 100, created_at: now - 7 * 24 * H };
  const fresh = { score: 15, created_at: now - H };
  assert.deepEqual(rankHot([old, fresh], now), [fresh, old]);
});

test('for-you favors categories with positive affinity', () => {
  const now = Date.now();
  const aff = categoryAffinity([
    { category_id: 1, kind: 'bookmark', n: 3 },
    { category_id: 2, kind: 'downvote', n: 4 },
  ]);
  const a = { id: 'a', category_id: 1, score: 5, created_at: now - 3_600_000 };
  const b = { id: 'b', category_id: 2, score: 5, created_at: now - 3_600_000 };
  assert.deepEqual(rankForYou([b, a], aff, now).map((d) => d.id), ['a', 'b']);
});
