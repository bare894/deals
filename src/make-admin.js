// Create the first admin, or promote an existing account (Admin Mode can't create admins).
//
//   npm run make-admin -- --email you@example.com --handle yourname [--password '…']
//
// Uses DATABASE_URL if set, otherwise the local data/pglite. A new account without --password
// gets a random one, printed once. An existing account (matched by email or handle) is promoted
// and keeps its password unless --password is given.
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openDb } from './db.js';
import { hashPassword } from './auth.js';

const { values: args } = parseArgs({ options: { email: { type: 'string' }, handle: { type: 'string' }, password: { type: 'string' } } });
const email = String(args.email || '').trim().toLowerCase();
const handle = String(args.handle || '').trim();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^[A-Za-z0-9_]{3,24}$/.test(handle)) {
  console.error('Usage: npm run make-admin -- --email you@example.com --handle yourname [--password ...]');
  console.error('Handle: 3–24 letters, numbers or underscores.');
  process.exit(1);
}
if (args.password != null && args.password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = await openDb(process.env.DATABASE_URL || path.join(root, 'data', 'pglite'));
try {
  const existing = await db.all('SELECT id, email, handle, role FROM users WHERE lower(email) = lower(?) OR lower(handle) = lower(?)', email, handle);
  if (existing.length > 1) {
    console.error(`That email and handle belong to two different accounts (@${existing[0].handle}, @${existing[1].handle}). Pick one.`);
    process.exitCode = 1;
  } else if (existing.length === 1) {
    const u = existing[0];
    await db.run("UPDATE users SET role = 'admin', status = 'active' WHERE id = ?", u.id);
    if (args.password) await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(args.password), u.id);
    console.log(`@${u.handle} (${u.email}) is now an admin${args.password ? ' with the new password' : '; password unchanged'}.`);
  } else {
    const password = args.password || randomBytes(15).toString('base64url');
    await db.run(
      "INSERT INTO users (email, handle, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
      email, handle, hashPassword(password), Date.now(),
    );
    console.log(`Created admin @${handle} (${email}).`);
    if (!args.password) console.log(`Password: ${password}\nIt is shown only this once. Sign in and keep it in a password manager.`);
  }
} finally {
  await db.close();
}
