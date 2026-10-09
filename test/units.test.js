import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeUrl, parseDealUrl } from '../src/canonicalize.js';
import { extractDealFields, isPrivateIp, parsePrice, storeFromHost, autoPopulate, findMrp, guessCategory } from '../src/scrape.js';
import { hotScore, rankHot, rankForYou, categoryAffinity } from '../src/ranking.js';
import { clientIp } from '../src/http.js';

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

test('Indian marketplace URLs collapse to their product id', () => {
  // Flipkart: slug, search context and tracking params vary; itm id + pid (variant) identify the product.
  const fk = 'https://flipkart.com/p/itm6ac6485515ae4?pid=MOBGTAGPTB3VS24W';
  assert.equal(
    canonicalizeUrl('https://www.flipkart.com/apple-iphone-15-black-128-gb/p/itm6ac6485515ae4?pid=MOBGTAGPTB3VS24W&lid=LSTMOB123&marketplace=FLIPKART&q=iphone&srno=s_1_1&otracker=search&fm=organic&iid=abc'),
    fk,
  );
  assert.equal(canonicalizeUrl('https://dl.flipkart.com/s/apple-iphone-15/p/itm6ac6485515ae4?pid=MOBGTAGPTB3VS24W&affid=xyz'), fk);
  assert.notEqual(canonicalizeUrl('https://www.flipkart.com/x/p/itm6ac6485515ae4?pid=OTHERVARIANT'), fk, 'different variant');
  // Myntra: numeric style id.
  assert.equal(canonicalizeUrl('https://www.myntra.com/sports-shoes/puma/puma-men-softride/24563110/buy?utm_source=share'), 'https://myntra.com/24563110');
  assert.equal(canonicalizeUrl('https://www.myntra.com/24563110'), 'https://myntra.com/24563110');
  // Nykaa keeps the shade (skuId); AJIO / Meesho use the /p/ code.
  assert.equal(canonicalizeUrl('https://www.nykaa.com/maybelline-fit-me/p/41546?productId=41546&skuId=41544&pps=1'), 'https://nykaa.com/p/41546?skuId=41544');
  assert.equal(canonicalizeUrl('https://www.ajio.com/us-polo-assn-polo/p/469581377_navy?utm_medium=x'), 'https://ajio.com/p/469581377_navy');
  assert.equal(canonicalizeUrl('https://www.meesho.com/cotton-bedsheet/p/3k2j9x'), 'https://meesho.com/p/3k2j9x');
  // amazon.in is handled by the ASIN rule.
  assert.equal(canonicalizeUrl('https://www.amazon.in/boAt-Airdopes-141/dp/B09N3XMZ5F/ref=sr_1_1?tag=deal-21'), 'https://amazon.in/dp/B09N3XMZ5F');
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
  const f = extractDealFields(html, 'https://www.meesho.com/p/lamp');
  assert.equal(f.title, 'Cool Lamp');
  assert.equal(f.imageUrl, 'https://www.meesho.com/a.png');
  assert.equal(f.price, 19.5);
  assert.equal(f.store, 'Meesho');
  assert.equal(extractDealFields('<title> Plain   Page </title>', 'https://x.com').title, 'Plain Page');
});

test('autoPopulate degrades gracefully when the fetch fails (PRD §9.1)', async () => {
  const r = await autoPopulate('https://www.myntra.com/24563110', async () => {
    throw Object.assign(new Error('nope'), { code: 'ECONNRESET' });
  });
  assert.equal(r.ok, false);
  assert.equal(r.fields.store, 'Myntra');
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
  assert.equal(parsePrice('₹1,29,999'), 129999, 'Indian lakh grouping');
  assert.equal(parsePrice('Rs. 2,449.50'), 2449.5);
  assert.equal(parsePrice('1,234.56'), 1234.56);
  assert.equal(parsePrice(''), null);
  assert.equal(storeFromHost('www.flipkart.com'), 'Flipkart');
  assert.equal(storeFromHost('dl.flipkart.com'), 'Flipkart');
  assert.equal(storeFromHost('www.amazon.in'), 'Amazon');
  assert.equal(storeFromHost('www.ajio.com'), 'AJIO');
  assert.equal(storeFromHost('www.nykaa.com'), 'Nykaa');
  assert.equal(storeFromHost('shop.acme.co.in'), 'Acme', '.co.in domains');
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

test('client IP: socket address by default; behind trusted proxies, the hop they appended', () => {
  const req = (xff) => ({ socket: { remoteAddress: '10.0.0.5' }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.equal(clientIp(req('203.0.113.9'), 0), '10.0.0.5');
  assert.equal(clientIp(req('203.0.113.9'), 1), '203.0.113.9');
  // A client can prepend fake entries; only the proxy-appended (rightmost) one counts.
  assert.equal(clientIp(req('1.1.1.1, 203.0.113.9'), 1), '203.0.113.9');
  assert.equal(clientIp(req('1.1.1.1, 203.0.113.9, 172.16.0.2'), 2), '203.0.113.9');
  assert.equal(clientIp(req(''), 1), '10.0.0.5');
});

test('MRP: visible label, Amazon strike-through, embedded JSON; implausible values rejected', () => {
  // Amazon.in buy box (no JSON-LD on Amazon)
  const amazon = `<span class="a-size-small aok-offscreen apex-basisprice-offscreen-label">M.R.P.: ₹55,999.00</span>`;
  assert.equal(findMrp(amazon, 51430), 55999);
  assert.equal(findMrp('<span class="a-price a-text-price" data-a-strike="true" data-a-color="secondary"><span class="a-offscreen">₹4,490.00</span>', 1099), 4490);
  // Flipkart / Myntra embedded state; a "-₹8,000 off" label next to "MRP" is not the MRP
  assert.equal(findMrp('"label":"MRP"}},"x":{"value":{"text":"-₹8,000"}} … "mrp":55999,"fsp":47999', 47999), 55999);
  assert.equal(findMrp('"price":{"mrp":{"currency":"INR","value":2999}}', 1199), 2999);
  assert.equal(findMrp('MRP ₹999', 1999), null); // below the selling price
  assert.equal(findMrp('"mrp":9999999', 1999), null); // another product's price, not 5000× this one
  // Large pages full of near-misses must stay fast (no catastrophic regex backtracking).
  const t = Date.now();
  findMrp(`${'MRP '.repeat(5000)}${'<span class="x">'.repeat(20000)}`, 100);
  assert.ok(Date.now() - t < 500, 'findMrp is linear-time');
});

test('category: most specific breadcrumb wins, then the title', () => {
  assert.equal(guessCategory(['Electronics', 'Mobiles & Accessories', 'Smartphones & Basic Mobiles', 'Smartphones']), 'Mobiles');
  assert.equal(guessCategory(['Electronics', 'Wearable Technology', 'Smart Watches']), 'Electronics');
  assert.equal(guessCategory(['Clothing & Accessories', 'Men', 'Watches']), 'Fashion');
  assert.equal(guessCategory(['mobile']), 'Mobiles'); // Flipkart's Product.category
  assert.equal(guessCategory(['Home & Kitchen', 'Kitchen & Home Appliances', 'Mixer Grinders']), 'Home & Kitchen');
  assert.equal(guessCategory([], 'Puma Men Softride Running Shoes'), 'Fashion');
  assert.equal(guessCategory([], 'Something unrecognisable'), null);
});

test('Amazon.in pages: price, MRP, title, image and category without JSON-LD', () => {
  const html = `<html><head><title>Google Pixel 10a : Amazon.in: Electronics</title></head><body>
    <div id="wayfinding-breadcrumbs_feature_div"><ul><li><a href="/e">Electronics</a></li><li><a href="/m">Mobiles &amp; Accessories</a></li><li><a href="/s">Smartphones</a></li></ul></div>
    <span id="productTitle" class="a-size-large"> Google Pixel 10a 5G (Fog, 256GB) </span>
    <img alt="" src="https://m.media-amazon.com/images/I/small.jpg" data-old-hires="https://m.media-amazon.com/images/I/big.jpg" id="landingImage">
    <span class="a-price priceToPay" data-a-size="xl"><span class="a-offscreen"> </span><span class="a-price-whole">51,430</span></span>
    <span class="aok-offscreen">M.R.P.: ₹55,999.00</span></body></html>`;
  const f = extractDealFields(html, 'https://www.amazon.in/dp/B0GP8SY9MB');
  assert.equal(f.title, 'Google Pixel 10a 5G (Fog, 256GB)');
  assert.equal(f.imageUrl, 'https://m.media-amazon.com/images/I/big.jpg');
  assert.equal(f.price, 51430);
  assert.equal(f.fullPrice, 55999);
  assert.equal(f.category, 'Mobiles');
});

test('only approved stores can be posted; short links are judged by where they lead', async () => {
  const { resolveLink } = await import('../src/routes/common.js');
  let fetched = 0;
  const follow = (to) => async (u) => {
    fetched++;
    return new URL(to ?? u);
  };
  const ok = async (url, to) => (await resolveLink(url, follow(to))).storeKey;
  const refused = async (url, to) => {
    await assert.rejects(resolveLink(url, follow(to)), (err) => err.status === 400 && /can only be posted from Amazon, Flipkart/.test(err.message));
  };

  assert.equal(await ok('https://www.amazon.in/dp/B0GP8SY9MB'), 'amazon.in');
  assert.equal(await ok('amazon.in/dp/B0GP8SY9MB'), 'amazon.in');
  assert.equal(await ok('https://dl.flipkart.com/s/abc123'), 'flipkart.com');
  for (const u of ['https://www.tatacliq.com/p-1', 'https://www.jiomart.com/p/x', 'https://www.snapdeal.com/product/x/1', 'https://www.nykaa.com/x/p/1']) await ok(u);

  fetched = 0;
  await refused('https://www.amazon.com/dp/B0GP8SY9MB'); // not amazon.in
  await refused('https://www.nykaafashion.com/p/1');
  await refused('https://flipkart.com.deals-offer.in/p/1'); // look-alike
  await refused('https://www.shop.com/item/1');
  assert.equal(fetched, 0, 'non-approved sites are refused without being fetched');

  assert.equal(await ok('https://amzn.in/d/abc', 'https://www.amazon.in/dp/B0GP8SY9MB'), 'amazon.in');
  await refused('https://bit.ly/xyz', 'https://www.randomshop.com/p/1');
});
