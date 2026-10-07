// Demo data. Run directly (`npm run seed`) to wipe and reseed data/deals.db.
import path from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, ensureCategories, tx } from './db.js';
import { hashPassword } from './auth.js';
import { canonicalizeUrl, hashUrl } from './canonicalize.js';

export const DEMO_PASSWORD = 'password123';

const USERS = [
  ['admin', 'admin@dealshare.test', 'admin'],
  ['mod_maya', 'maya@dealshare.test', 'moderator'],
  ['alice', 'alice@dealshare.test', 'user'],
  ['bargainbob', 'bob@dealshare.test', 'user'],
  ['carol_saves', 'carol@dealshare.test', 'user'],
  ['dealhunter_dan', 'dan@dealshare.test', 'user'],
  ['erin', 'erin@dealshare.test', 'user'],
  ['frugal_frank', 'frank@dealshare.test', 'user'],
];

const search = {
  amazon: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
  bestbuy: (q) => `https://www.bestbuy.com/site/searchpage.jsp?st=${encodeURIComponent(q)}`,
  walmart: (q) => `https://www.walmart.com/search?q=${encodeURIComponent(q)}`,
  target: (q) => `https://www.target.com/s?searchTerm=${encodeURIComponent(q)}`,
  costco: (q) => `https://www.costco.com/CatalogSearch?keyword=${encodeURIComponent(q)}`,
  newegg: (q) => `https://www.newegg.com/p/pl?d=${encodeURIComponent(q)}`,
};
const STORE_NAMES = { amazon: 'Amazon', bestbuy: 'Best Buy', walmart: 'Walmart', target: 'Target', costco: 'Costco', newegg: 'Newegg' };

// [title, category, store, full, price, hoursAgo, details, placeholder label]
const DEALS = [
  ['Sony WH-1000XM5 Wireless Noise Cancelling Headphones', 'Electronics', 'bestbuy', 399.99, 279.99, 3, 'Lowest price I have seen outside Black Friday. All four colors. Free shipping or store pickup.', 'Headphones'],
  ['Apple AirPods Pro 2 (USB-C)', 'Electronics', 'amazon', 249, 169, 7, 'Sold and shipped by Amazon. Price drops at checkout for some accounts.', 'AirPods'],
  ['LG 65" C4 OLED 4K Smart TV', 'Electronics', 'costco', 2299.99, 1599.99, 20, 'Members only. Includes Costco 5-year warranty + extra 90-day return window.', 'OLED TV'],
  ['Samsung 990 Pro 2TB NVMe SSD', 'Electronics', 'newegg', 249.99, 139.99, 30, 'Use promo code SSDFALL at checkout. Limit 2 per customer.', 'NVMe SSD'],
  ['Anker 737 Power Bank 24,000mAh', 'Electronics', 'amazon', 149.99, 79.99, 50, 'Clip the on-page coupon for the extra $20 off.', 'Power Bank'],
  ['Ninja AF101 4-Quart Air Fryer', 'Home & Kitchen', 'walmart', 129.99, 59, 5, 'Rollback price. Free shipping with Walmart+ or orders $35+.', 'Air Fryer'],
  ['Instant Pot Duo 7-in-1, 6 Quart', 'Home & Kitchen', 'target', 99.99, 49.99, 26, 'Target Circle deal — add the offer in the app first.', 'Instant Pot'],
  ['Dyson V8 Cordless Vacuum', 'Home & Kitchen', 'target', 469.99, 299.99, 70, 'Online only. Ships free.', 'Dyson V8'],
  ['Lodge 12" Cast Iron Skillet', 'Home & Kitchen', 'amazon', 44.9, 24.9, 110, 'Classic. Pre-seasoned. Prime shipping.', 'Skillet'],
  ["Levi's Men's 505 Regular Fit Jeans", 'Fashion', 'amazon', 69.5, 29.99, 14, 'Price varies by size/color — 32x32 dark stonewash is the one at $29.99.', "Levi's"],
  ['Nike Revolution 7 Running Shoes', 'Fashion', 'walmart', 70, 39.97, 44, 'Most sizes still in stock as of posting.', 'Nike'],
  ['Kirkland Signature Organic Extra Virgin Olive Oil, 2L', 'Grocery', 'costco', 29.99, 21.99, 9, 'In-warehouse and online. Instant savings through end of month.', 'Olive Oil'],
  ['Starbucks Pike Place Whole Bean Coffee 28oz', 'Grocery', 'amazon', 24.99, 15.49, 60, 'Subscribe & Save brings it to ~$13.90.', 'Coffee'],
  ['Nintendo Switch OLED — Mario Kart 8 Bundle', 'Gaming', 'target', 399.99, 349.99, 2, 'Bundle includes full game download code + 3 months Switch Online.', 'Switch'],
  ['Xbox Wireless Controller — Carbon Black', 'Gaming', 'bestbuy', 59.99, 39.99, 18, 'Other colors $44.99.', 'Controller'],
  ['Elden Ring (PS5)', 'Gaming', 'walmart', 59.99, 24.88, 90, 'Physical copy. Free 2-day shipping.', 'Elden Ring'],
  ['Microsoft 365 Personal — 15 months', 'Software & Services', 'amazon', 99.99, 59.99, 36, 'Digital code. Stacks with existing subscriptions.', 'M365'],
  ['LEGO Star Wars Millennium Falcon 75375', 'Toys & Kids', 'target', 84.99, 67.99, 12, '20% off with Target Circle. Great gift idea.', 'LEGO'],
  ['Melissa & Doug Wooden Activity Table', 'Toys & Kids', 'walmart', 89.99, 54.99, 130, 'Assembly required.', 'Kids Table'],
  ['Oral-B iO Series 5 Electric Toothbrush', 'Health & Beauty', 'amazon', 129.99, 69.99, 22, 'Lightning deal — may sell out.', 'Oral-B'],
  ['CeraVe Moisturizing Cream 19oz', 'Health & Beauty', 'target', 19.99, 14.49, 85, 'Buy 2 get a $5 gift card.', 'CeraVe'],
  ['Samsonite Freeform 2-Piece Hardside Luggage Set', 'Travel', 'costco', 249.99, 179.99, 40, 'Carry-on + large spinner. Members only.', 'Luggage'],
  ['Logitech MX Master 3S Mouse', 'Electronics', 'newegg', 99.99, 69.99, 160, 'Graphite color only.', 'MX Master'],
  ['Free: 3 months of Audible Premium Plus', 'Software & Services', 'amazon', 44.85, 0, 55, 'New members only. Cancel anytime.', 'Audible'],
];

const COMMENTS = [
  'Great price, just ordered one. Thanks OP!',
  'Can confirm this works — price showed at checkout.',
  'Was this cheaper last Black Friday?',
  'Out of stock in my area, but shipping was available.',
  'Bought one last month at full price… price adjustment time.',
  'Mine arrived in 2 days, very happy with it.',
  'Is this the newest model?',
  'Coupon did not apply for me.',
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

export function seed(db) {
  ensureCategories(db);
  const rand = mulberry32(42);
  const now = Date.now();
  const H = 3_600_000;
  const cat = Object.fromEntries(db.prepare('SELECT id, name FROM categories').all().map((c) => [c.name, c.id]));
  const pw = hashPassword(DEMO_PASSWORD);

  tx(db, () => {
    const userIds = USERS.map(([handle, email, role], i) =>
      Number(db.prepare('INSERT INTO users (email, handle, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').run(email, handle, pw, role, now - (60 - i) * 24 * H).lastInsertRowid),
    );
    const posters = userIds.slice(1);

    DEALS.forEach(([title, category, store, full, price, hoursAgo, details, label], i) => {
      const url = search[store](title);
      const canonical = canonicalizeUrl(url);
      const created = now - hoursAgo * H;
      const poster = posters[i % posters.length];
      const hue = (i * 47) % 360;
      const dealId = Number(
        db
          .prepare(
            `INSERT INTO deals (submitted_by, title, image_url, category_id, full_price_cents, price_cents, store, source_url, canonical_url,
                                canonical_url_hash, details, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(poster, title, `/img/placeholder.svg?t=${encodeURIComponent(label)}&h=${hue}`, cat[category], Math.round(full * 100), Math.round(price * 100),
            STORE_NAMES[store], url, canonical, hashUrl(canonical), details, created, created).lastInsertRowid,
      );

      let up = 0;
      let down = 0;
      for (const voter of userIds) {
        if (voter === poster) continue;
        const r = rand();
        const v = r < 0.62 ? 1 : r < 0.72 ? -1 : 0;
        if (!v) continue;
        db.prepare('INSERT INTO votes (deal_id, user_id, value, created_at) VALUES (?, ?, ?, ?)').run(dealId, voter, v, created + H);
        v === 1 ? up++ : down++;
      }
      // Simulate the wider community so scores aren't capped at the number of demo accounts.
      up += Math.floor(rand() * 40 * Math.max(0.2, 1 - hoursAgo / 200));
      down += Math.floor(rand() * 5);
      db.prepare('UPDATE deals SET upvotes = ?, downvotes = ?, score = ? WHERE id = ?').run(up, down, up - down, dealId);

      const nComments = Math.floor(rand() * 4);
      for (let c = 0; c < nComments; c++) {
        const author = userIds[1 + Math.floor(rand() * (userIds.length - 1))];
        db.prepare('INSERT INTO comments (deal_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(
          dealId, author, COMMENTS[Math.floor(rand() * COMMENTS.length)], created + (c + 1) * 0.5 * H,
        );
      }
    });

    // A few bookmarks and an open report so Admin Mode has something to show.
    const alice = userIds[2];
    for (const d of [1, 6, 14]) db.prepare('INSERT OR IGNORE INTO bookmarks (user_id, deal_id, created_at) VALUES (?, ?, ?)').run(alice, d, now - H);
    db.prepare("INSERT INTO reports (reporter_id, target_type, target_id, reason, created_at) VALUES (?, 'deal', 9, 'expired: price is back to $44.90', ?)").run(userIds[4], now - 2 * H);
    db.prepare("INSERT INTO reports (reporter_id, target_type, target_id, reason, created_at) VALUES (?, 'deal', 9, 'expired', ?)").run(userIds[5], now - H);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dbFile = process.env.DB_FILE || path.join(root, 'data', 'deals.db');
  if (process.argv.includes('--reset')) for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) rmSync(f, { force: true });
  mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = openDb(dbFile);
  seed(db);
  console.log(`Seeded ${dbFile}. Demo accounts (password "${DEMO_PASSWORD}"): ${USERS.map((u) => `${u[0]} (${u[2]})`).join(', ')}`);
}
