// GET /api/health: is the app up and talking to its database?
// Public: status + database kind (also usable as Railway's healthcheck path: 503 when the DB is down).
// Admins additionally see connection details, minus anything secret (no URL, user or password).
import { HttpError } from '../http.js';

export function registerHealthRoutes({ route, db }) {
  route('GET', '/api/health', async ({ user }) => {
    const started = Date.now();
    let info;
    try {
      info = await db.get(
        `SELECT current_database() AS database, split_part(version(), ' ', 2) AS server_version,
                (SELECT MAX(version) FROM schema_migrations) AS schema_version,
                (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM deals) AS deals`,
      );
    } catch (err) {
      console.error('[health] database check failed:', err.message);
      throw new HttpError(503, 'Database unavailable', { ok: false, database: db.kind });
    }
    const status = { ok: true, database: db.kind, latencyMs: Date.now() - started };
    if (user?.role !== 'admin') return status;
    return {
      ...status,
      // pglite = embedded local database; on Railway this must say postgres, or data won't survive deploys.
      persistent: db.kind === 'postgres',
      databaseName: info.database,
      serverVersion: info.server_version,
      schemaVersion: info.schema_version,
      rows: { users: info.users, deals: info.deals },
      env: {
        NODE_ENV: process.env.NODE_ENV || null,
        DATABASE_URL: process.env.DATABASE_URL ? 'set (hidden)' : 'NOT SET',
        SEED: process.env.SEED ?? null,
        TRUST_PROXY: process.env.TRUST_PROXY ?? null,
        PUBLIC_URL: process.env.PUBLIC_URL || null,
        railwayEnvironment: process.env.RAILWAY_ENVIRONMENT_NAME || null,
        railwayService: process.env.RAILWAY_SERVICE_NAME || null,
        deployCommit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || null,
        googleSignIn: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
        facebookSignIn: Boolean(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET),
      },
    };
  });
}
