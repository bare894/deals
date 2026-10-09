import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  handle        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','moderator','admin')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','banned')),
  created_at    INTEGER NOT NULL
);

-- Social sign-in links: one row per (provider, provider's user id). A user can link several.
CREATE TABLE IF NOT EXISTS oauth_identities (
  provider   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  slug   TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

-- A deal is a PRODUCT post ("Sony WH-1000XM6"). Votes, comments and bookmarks belong to it.
-- Where to buy it lives in offers; best_* columns cache the cheapest active offer for listings.
CREATE TABLE IF NOT EXISTS deals (
  id                    INTEGER PRIMARY KEY,
  submitted_by          INTEGER NOT NULL REFERENCES users(id),
  title                 TEXT NOT NULL,
  image_url             TEXT,
  category_id           INTEGER REFERENCES categories(id),
  details               TEXT NOT NULL DEFAULT '',
  gtin                  TEXT,
  mpn                   TEXT,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  merged_into           INTEGER REFERENCES deals(id),
  upvotes               INTEGER NOT NULL DEFAULT 0,
  downvotes             INTEGER NOT NULL DEFAULT 0,
  score                 INTEGER NOT NULL DEFAULT 0,
  best_price_cents      INTEGER,
  best_full_price_cents INTEGER,
  best_store            TEXT,
  offer_count           INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  removed_at            INTEGER,
  removed_by            INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS deals_created ON deals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS deals_category ON deals(category_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS deals_gtin ON deals(gtin) WHERE gtin IS NOT NULL;

-- One store's listing of a deal's product. source_url is kept exactly as the poster submitted
-- it (it may carry their affiliate tag); canonical_url_hash is what dedup compares.
CREATE TABLE IF NOT EXISTS offers (
  id                 INTEGER PRIMARY KEY,
  deal_id            INTEGER NOT NULL REFERENCES deals(id),
  submitted_by       INTEGER NOT NULL REFERENCES users(id),
  store              TEXT NOT NULL,
  store_key          TEXT NOT NULL,
  source_url         TEXT NOT NULL,
  canonical_url      TEXT NOT NULL,
  canonical_url_hash TEXT NOT NULL,
  price_cents        INTEGER NOT NULL,
  full_price_cents   INTEGER,
  note               TEXT NOT NULL DEFAULT '',
  -- deal_removed: hidden because its deal was removed (restoring the deal brings it back).
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed','deal_removed')),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  removed_at         INTEGER,
  removed_by         INTEGER REFERENCES users(id)
);
-- Dedup (PRD §10.2), enforced by the database: an exact product link can be live only once
-- site-wide, and each store can appear only once per deal.
CREATE UNIQUE INDEX IF NOT EXISTS offers_active_url ON offers(canonical_url_hash) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS offers_active_store ON offers(deal_id, store_key) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS offers_deal ON offers(deal_id, status);
CREATE INDEX IF NOT EXISTS offers_user ON offers(submitted_by);

CREATE TABLE IF NOT EXISTS votes (
  id         INTEGER PRIMARY KEY,
  deal_id    INTEGER NOT NULL REFERENCES deals(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  value      INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at INTEGER NOT NULL,
  UNIQUE (deal_id, user_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY,
  deal_id    INTEGER NOT NULL REFERENCES deals(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','removed')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_deal ON comments(deal_id, created_at);

CREATE TABLE IF NOT EXISTS bookmarks (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  deal_id    INTEGER NOT NULL REFERENCES deals(id),
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, deal_id)
);

CREATE TABLE IF NOT EXISTS views (
  user_id   INTEGER NOT NULL REFERENCES users(id),
  deal_id   INTEGER NOT NULL REFERENCES deals(id),
  viewed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, deal_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY,
  reporter_id INTEGER NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('deal','comment','offer')),
  target_id   INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at  INTEGER NOT NULL,
  resolved_by INTEGER REFERENCES users(id),
  resolved_at INTEGER,
  UNIQUE (reporter_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS reports_open ON reports(status, target_type, target_id);

CREATE TABLE IF NOT EXISTS moderation_actions (
  id          INTEGER PRIMARY KEY,
  actor_id    INTEGER NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('deal','comment','offer','user','category')),
  target_id   INTEGER NOT NULL,
  action      TEXT NOT NULL,
  reason      TEXT,
  created_at  INTEGER NOT NULL
);
`;

const SCHEMA_VERSION = 2;
const TABLES = ['moderation_actions', 'reports', 'views', 'bookmarks', 'comments', 'votes', 'offers', 'deals', 'categories', 'sessions', 'oauth_identities', 'users'];

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  const hasTables = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deals'").get();
  if (hasTables && version < SCHEMA_VERSION) {
    // v1 stored one URL per deal. This is a prototype with demo data only, so rebuild rather
    // than migrate; server.js reseeds an empty database on startup.
    console.warn(`Database schema v${version} is outdated — rebuilding at v${SCHEMA_VERSION} (demo data will be reseeded).`);
    for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const DEFAULT_CATEGORIES = [
  'Mobiles', 'Electronics', 'Fashion', 'Beauty & Personal Care', 'Home & Kitchen', 'Grocery',
  'Travel', 'Gaming', 'Toys & Kids', 'Apps & Services', 'Other',
];

export function slugify(name) {
  return String(name).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function ensureCategories(db) {
  const insert = db.prepare('INSERT OR IGNORE INTO categories (name, slug) VALUES (?, ?)');
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM categories').get();
  if (n === 0) for (const name of DEFAULT_CATEGORIES) insert.run(name, slugify(name));
}
