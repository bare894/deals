// Create or update the tables without starting the server (the server also does this on boot).
//   DATABASE_URL=postgres://… npm run migrate
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, ensureCategories } from './db.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = await openDb(process.env.DATABASE_URL || path.join(root, 'data', 'pglite')); // applies pending migrations
await ensureCategories(db);
const tables = await db.all("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1");
const { v } = await db.get('SELECT MAX(version) AS v FROM schema_migrations');
console.log(`${db.kind} database is at schema version ${v}: ${tables.map((t) => t.table_name).join(', ')}`);
await db.close();
