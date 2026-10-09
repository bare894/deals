import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, ensureCategories } from './src/db.js';
import { createApp } from './src/app.js';
import { seed } from './src/seed.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
// Production: DATABASE_URL (Railway Postgres). Local dev: embedded Postgres (PGlite) under data/.
const dbTarget = process.env.DATABASE_URL || path.join(root, 'data', 'pglite');

const db = await openDb(dbTarget);
await ensureCategories(db);
if ((await db.get('SELECT COUNT(*) AS n FROM users')).n === 0 && process.env.SEED !== '0') {
  await seed(db);
  console.log('Seeded demo data (admin/moderator/user accounts + sample deals).');
}

const app = createApp({
  db,
  publicDir: path.join(root, 'public'),
  secureCookies: process.env.NODE_ENV === 'production',
});

const server = http.createServer(app).listen(port, () => {
  console.log(`ShareDeals running at http://localhost:${port} (database: ${db.kind})`);
});

// Railway sends SIGTERM on redeploy: finish in-flight requests, then close the pool.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
