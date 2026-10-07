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

CREATE TABLE IF NOT EXISTS deals (
  id                 INTEGER PRIMARY KEY,
  submitted_by       INTEGER NOT NULL REFERENCES users(id),
  title              TEXT NOT NULL,
  image_url          TEXT,
  category_id        INTEGER REFERENCES categories(id),
  full_price_cents   INTEGER,
  price_cents        INTEGER,
  store              TEXT,
  source_url         TEXT NOT NULL,
  canonical_url      TEXT NOT NULL,
  canonical_url_hash TEXT NOT NULL,
  details            TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  upvotes            INTEGER NOT NULL DEFAULT 0,
  downvotes          INTEGER NOT NULL DEFAULT 0,
  score              INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  removed_at         INTEGER,
  removed_by         INTEGER REFERENCES users(id)
);
-- Dedup (PRD §10.2): enforced by the database, not just app code. Only ACTIVE deals
-- reserve a URL, so a moderator-removed deal's URL becomes postable again (Open Q #4).
CREATE UNIQUE INDEX IF NOT EXISTS deals_active_url ON deals(canonical_url_hash) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS deals_created ON deals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS deals_category ON deals(category_id, status, created_at DESC);

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
  target_type TEXT NOT NULL CHECK (target_type IN ('deal','comment')),
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
  target_type TEXT NOT NULL CHECK (target_type IN ('deal','comment','user','category')),
  target_id   INTEGER NOT NULL,
  action      TEXT NOT NULL,
  reason      TEXT,
  created_at  INTEGER NOT NULL
);
`;

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
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
  'Electronics', 'Home & Kitchen', 'Fashion', 'Grocery', 'Travel', 'Gaming',
  'Software & Services', 'Toys & Kids', 'Health & Beauty', 'Other',
];

export function slugify(name) {
  return String(name).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function ensureCategories(db) {
  const insert = db.prepare('INSERT OR IGNORE INTO categories (name, slug) VALUES (?, ?)');
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM categories').get();
  if (n === 0) for (const name of DEFAULT_CATEGORIES) insert.run(name, slugify(name));
}
