import http from 'node:http';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, ensureCategories } from './src/db.js';
import { createApp } from './src/app.js';
import { seed } from './src/seed.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const dbFile = process.env.DB_FILE || path.join(root, 'data', 'deals.db');

mkdirSync(path.dirname(dbFile), { recursive: true });
const db = openDb(dbFile);
ensureCategories(db);
if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0 && process.env.SEED !== '0') {
  seed(db);
  console.log('Seeded demo data (admin/moderator/user accounts + sample deals).');
}

const app = createApp({
  db,
  publicDir: path.join(root, 'public'),
  secureCookies: process.env.NODE_ENV === 'production',
});

http.createServer(app).listen(port, () => {
  console.log(`ShareDeals running at http://localhost:${port}`);
});
