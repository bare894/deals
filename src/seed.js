// Demo data (India). Run directly (`npm run seed`) to wipe and reseed the database
// (DATABASE_URL if set, otherwise the local data/pglite).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, ensureCategories, resetDb, tx } from './db.js';
import { hashPassword } from './auth.js';
import { canonicalizeUrl, hashUrl, registrableDomain } from './canonicalize.js';
import { createRepo } from './repo.js';

export const DEMO_PASSWORD = 'password123';

const USERS = [
  ['admin', 'admin@sharedeals.in', 'admin'],
  ['mod_priya', 'priya@sharedeals.in', 'moderator'],
  ['rahul', 'rahul@sharedeals.in', 'user'],
  ['deal_guru_amit', 'amit@sharedeals.in', 'user'],
  ['sneha_saves', 'sneha@sharedeals.in', 'user'],
  ['karan_k', 'karan@sharedeals.in', 'user'],
  ['ananya', 'ananya@sharedeals.in', 'user'],
  ['frugal_vikram', 'vikram@sharedeals.in', 'user'],
];

// Seed links point at real retailer search pages so "Get deal" always lands somewhere useful.
const q = encodeURIComponent;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const STORES = {
  flipkart: ['Flipkart', (t) => `https://www.flipkart.com/search?q=${q(t)}`],
  amazon: ['Amazon', (t) => `https://www.amazon.in/s?k=${q(t)}`],
  myntra: ['Myntra', (t) => `https://www.myntra.com/${slug(t)}?rawQuery=${q(t)}`],
  ajio: ['AJIO', (t) => `https://www.ajio.com/search/?text=${q(t)}`],
  nykaa: ['Nykaa', (t) => `https://www.nykaa.com/search/result/?q=${q(t)}`],
  meesho: ['Meesho', (t) => `https://www.meesho.com/search?q=${q(t)}`],
  croma: ['Croma', (t) => `https://www.croma.com/searchB?q=${q(t)}`],
};

// [title, category, placeholder label, hoursAgo, details, offers: [store, MRP ₹, price ₹, note]]
// Several products are listed at more than one store, each listing posted by a different user.
const DEALS = [
  ['Sony WH-1000XM6 Wireless Noise Cancelling Headphones', 'Electronics', 'Sony XM6', 4,
    'Sony’s newest flagship ANC headphones. Lowest price since launch across stores — compare below.', [
      ['amazon', 44990, 37990, '10% instant discount up to ₹1,500 with ICICI cards'],
      ['flipkart', 44990, 38490, 'Extra ₹2,000 off with Flipkart Axis Bank card'],
      ['croma', 44990, 39990, 'Free 1-year extended warranty with Croma ZipCare'],
    ]],
  ['Apple iPhone 15 (Black, 128 GB)', 'Mobiles', 'iPhone 15', 3,
    'Exchange offers up to ₹40,000 depending on your old phone. Check delivery for your pincode.', [
      ['flipkart', 69900, 57999, 'Extra ₹1,000 off with HDFC Bank credit cards'],
      ['amazon', 69900, 59900, 'No-cost EMI on Amazon Pay ICICI card'],
    ]],
  ['boAt Airdopes 141 Bluetooth TWS Earbuds', 'Electronics', 'Airdopes 141', 7,
    '42 hours playback, ENx noise cancellation for calls, IPX4.', [
      ['amazon', 4490, 1099, 'Lightning deal — Prime members get next-day delivery in metros'],
    ]],
  ['Samsung Galaxy S24 FE 5G (8GB / 128GB)', 'Mobiles', 'Galaxy S24 FE', 20,
    'Big price drop. Extra ₹2,000 off on exchange at both stores.', [
      ['flipkart', 59999, 34999, 'No-cost EMI from ₹5,834/month'],
      ['amazon', 59999, 35999, ''],
    ]],
  ['Puma Men Softride Running Shoes', 'Fashion', 'Puma', 14,
    'Most sizes (UK 7–11) in stock as of posting.', [
      ['myntra', 6999, 2449, 'Extra ₹200 off with coupon on your first Myntra order'],
      ['ajio', 6999, 2519, 'AJIO points can be applied'],
    ]],
  ['Prestige Iris 750W Mixer Grinder (3 Jars)', 'Home & Kitchen', 'Mixer Grinder', 5,
    '2-year warranty. Three stainless steel jars + juicer jar.', [
      ['amazon', 4545, 2399, 'Clip the ₹200 coupon on the product page'],
      ['flipkart', 4545, 2499, ''],
    ]],
  ['Libas Women Kurta with Palazzos & Dupatta Set', 'Fashion', 'Kurta Set', 26,
    'End of Reason Sale price. Free delivery and easy 14-day returns.', [
      ['myntra', 4999, 1399, ''],
    ]],
  ['Tata Sampann Unpolished Toor Dal, 1 kg (Pack of 2)', 'Grocery', 'Toor Dal', 9,
    'Subscribe & Save brings it down a further 5%.', [
      ['amazon', 398, 289, ''],
    ]],
  ['Maybelline New York Fit Me Matte + Poreless Foundation', 'Beauty & Personal Care', 'Fit Me', 12,
    'Available in most shades.', [
      ['nykaa', 649, 454, '30% off during Nykaa Pink Friday. Free gift above ₹999'],
      ['amazon', 649, 469, ''],
      ['myntra', 649, 487, ''],
    ]],
  ['U.S. Polo Assn. Men Slim Fit Polo T-shirt', 'Fashion', 'US Polo', 22,
    'Prices vary by colour.', [
      ['ajio', 1899, 759, 'Use code EXTRA300 on orders above ₹1,499'],
    ]],
  ['Cotton Printed Double Bedsheet with 2 Pillow Covers', 'Home & Kitchen', 'Bedsheet', 2,
    'Check seller ratings before buying.', [
      ['meesho', 1299, 349, 'Free delivery, Cash on Delivery available'],
    ]],
  ['Sony PlayStation 5 Slim Console (Digital Edition)', 'Gaming', 'PS5 Slim', 18,
    'Limited stock at this price.', [
      ['amazon', 44990, 37490, '₹3,000 instant discount on SBI credit cards'],
      ['flipkart', 44990, 37990, ''],
    ]],
  ['Skechers Women Go Walk Flex Sneakers', 'Fashion', 'Skechers', 50,
    'Flat 50% off.', [
      ['ajio', 5999, 2999, ''],
    ]],
  ['American Tourister 3-Piece Trolley Luggage Set', 'Travel', 'Luggage', 40,
    'Cabin + medium + large. Great for the wedding season.', [
      ['ajio', 17500, 6299, ''],
      ['amazon', 17500, 6999, ''],
    ]],
  ['The Derma Co 1% Hyaluronic Sunscreen SPF 50, 50 g', 'Beauty & Personal Care', 'Sunscreen', 36,
    'Lightweight gel sunscreen.', [
      ['nykaa', 599, 419, 'Buy 2, get an extra 10% off'],
    ]],
  ['Samsung 7 kg 5-Star Fully Automatic Front Load Washing Machine', 'Home & Kitchen', 'Washing Machine', 70,
    'Free installation.', [
      ['flipkart', 41900, 28990, '10% instant discount with SBI cards'],
    ]],
  ['Kids Remote Control Racing Car with Rechargeable Battery', 'Toys & Kids', 'RC Car', 55,
    'Delivery in 5–7 days.', [
      ['meesho', 1499, 449, 'COD available'],
    ]],
  ["Levi's Men 511 Slim Fit Jeans", 'Fashion', "Levi's", 44,
    'Price varies by size and wash.', [
      ['myntra', 3599, 1619, 'The 32 dark indigo is the one at ₹1,619'],
    ]],
  ['Philips BHH880 Heated Hair Straightening Brush', 'Beauty & Personal Care', 'Hair Brush', 85,
    '2-year Philips warranty.', [
      ['nykaa', 3195, 1999, 'Nykaa exclusive price'],
    ]],
  ['Motorola Edge 50 Fusion 5G (8GB / 128GB)', 'Mobiles', 'Moto Edge 50', 60,
    'Free delivery.', [
      ['flipkart', 25999, 20999, 'Includes ₹1,000 Axis Bank card offer'],
    ]],
  ["Women's Georgette Printed Saree with Blouse Piece", 'Fashion', 'Saree', 90,
    'Lowest price this month.', [
      ['meesho', 2499, 399, 'Free delivery, COD available'],
    ]],
  ['Hot Wheels 10-Car Pack', 'Toys & Kids', 'Hot Wheels', 130,
    'Great Diwali gift. Assorted cars.', [
      ['flipkart', 1299, 899, ''],
    ]],
  ['Kindle Paperwhite (16 GB) — 7" Display', 'Electronics', 'Kindle', 110,
    'Bundle with a cover for ₹500 more.', [
      ['amazon', 16999, 13999, ''],
    ]],
  ['Free: 3 months of Amazon Music Unlimited', 'Apps & Services', 'Music', 55,
    'New subscribers only. Auto-renews at ₹119/month — cancel anytime.', [
      ['amazon', 357, 0, ''],
    ]],
  // Posted separately before anyone noticed — shows up in Admin Mode → Duplicates for merging.
  ['boAt Airdopes 141 TWS Earbuds with 42H Playtime', 'Electronics', 'Airdopes', 1,
    'Flipkart has it slightly cheaper with the bank offer.', [
      ['flipkart', 4490, 1199, '5% cashback with Flipkart Axis Bank card'],
    ]],
];

const COMMENTS = [
  'Got it with the HDFC card offer — final price was even lower. Thanks for posting!',
  'Is Cash on Delivery available for this?',
  'Not deliverable to my pincode 😕',
  'It was cheaper during Big Billion Days.',
  'Delivered in 2 days in Bengaluru, packaging was good.',
  'Bank offer is not applying for me on the app.',
  'Great that we can compare stores here — Amazon was cheaper for me after the card offer.',
  'Bought one — quality is decent for the price.',
];

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function seed(db) {
  await ensureCategories(db);
  const repo = createRepo(db);
  const rand = mulberry32(42);
  const now = Date.now();
  const H = 3_600_000;
  const cat = Object.fromEntries((await db.all('SELECT id, name FROM categories')).map((c) => [c.name, c.id]));
  const pw = hashPassword(DEMO_PASSWORD);

  await tx(db, async () => {
    const userIds = [];
    for (const [i, [handle, email, role]] of USERS.entries()) {
      const { id } = await db.get(
        'INSERT INTO users (email, handle, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
        email, handle, pw, role, now - (60 - i) * 24 * H,
      );
      userIds.push(id);
    }
    const posters = userIds.slice(1);
    const insertOffer = (...params) =>
      db.run(
        `INSERT INTO offers (deal_id, submitted_by, store, store_key, source_url, canonical_url, canonical_url_hash, price_cents, full_price_cents, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ...params,
      );
    const dealIds = [];

    for (const [i, [title, category, label, hoursAgo, details, offers]] of DEALS.entries()) {
      const created = now - hoursAgo * H;
      const creator = posters[i % posters.length];
      const hue = (i * 47) % 360;
      const { id: dealId } = await db.get(
        'INSERT INTO deals (submitted_by, title, image_url, category_id, details, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
        creator, title, `/img/placeholder.svg?t=${encodeURIComponent(label)}&h=${hue}`, cat[category], details, created, created,
      );
      dealIds.push(dealId);

      for (const [j, [store, mrp, price, note]] of offers.entries()) {
        const [storeName, makeUrl] = STORES[store];
        const url = makeUrl(title);
        const canonical = canonicalizeUrl(url);
        // First listing is the creator's; extra stores were added later by other users.
        const poster = j === 0 ? creator : posters[(i + j * 3) % posters.length];
        const at = created + j * 1.5 * H;
        await insertOffer(dealId, poster, storeName, registrableDomain(new URL(canonical).hostname), url, canonical, hashUrl(canonical),
          Math.round(price * 100), Math.round(mrp * 100), note, at, at);
      }
      await repo.refreshDealPricing(dealId);

      let up = 0;
      let down = 0;
      for (const voter of userIds) {
        if (voter === creator) continue;
        const r = rand();
        const v = r < 0.62 ? 1 : r < 0.72 ? -1 : 0;
        if (!v) continue;
        await db.run('INSERT INTO votes (deal_id, user_id, value, created_at) VALUES (?, ?, ?, ?)', dealId, voter, v, created + H);
        v === 1 ? up++ : down++;
      }
      // Simulate the wider community so scores aren't capped at the number of demo accounts.
      up += Math.floor(rand() * 40 * Math.max(0.2, 1 - hoursAgo / 200));
      down += Math.floor(rand() * 5);
      await db.run('UPDATE deals SET upvotes = ?, downvotes = ?, score = ? WHERE id = ?', up, down, up - down, dealId);

      const nComments = Math.floor(rand() * 4);
      for (let c = 0; c < nComments; c++) {
        const author = userIds[1 + Math.floor(rand() * (userIds.length - 1))];
        await db.run(
          'INSERT INTO comments (deal_id, user_id, body, created_at) VALUES (?, ?, ?, ?)',
          dealId, author, COMMENTS[Math.floor(rand() * COMMENTS.length)], created + (c + 1) * 0.5 * H,
        );
      }
    }

    // A few bookmarks and open reports so Admin Mode has something to show.
    const rahul = userIds[2];
    for (const i of [0, 5, 13]) {
      await db.run('INSERT INTO bookmarks (user_id, deal_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', rahul, dealIds[i], now - H);
    }
    const dalOffer = (await db.get('SELECT o.id FROM offers o JOIN deals d ON d.id = o.deal_id WHERE d.title LIKE ?', 'Tata Sampann%')).id;
    await db.run("INSERT INTO reports (reporter_id, target_type, target_id, reason, created_at) VALUES (?, 'offer', ?, 'expired: price is back to ₹398', ?)", userIds[4], dalOffer, now - 2 * H);
    await db.run("INSERT INTO reports (reporter_id, target_type, target_id, reason, created_at) VALUES (?, 'offer', ?, 'expired', ?)", userIds[5], dalOffer, now - H);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const target = process.env.DATABASE_URL || path.join(root, 'data', 'pglite');
  if (process.env.NODE_ENV === 'production' && !process.argv.includes('--yes-wipe-production')) {
    console.error('Refusing to wipe a production database. Pass --yes-wipe-production if you really mean it.');
    process.exit(1);
  }
  const db = await openDb(target);
  if (process.argv.includes('--reset')) await resetDb(db);
  await seed(db);
  await db.close();
  console.log(`Seeded ${db.kind} database. Demo accounts (password "${DEMO_PASSWORD}"): ${USERS.map((u) => `${u[0]} (${u[2]})`).join(', ')}`);
}
