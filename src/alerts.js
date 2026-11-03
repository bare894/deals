// Alerts: saved search phrases ("iphone 15", "lego technic"), up to MAX_ALERTS per user. Once an
// hour a job looks for deals posted since each alert was made that match it and pushes one
// notification per user to the Android app (src/push.js). Not done when deals are posted, to
// keep posting cheap; alert_hits makes sure a deal is only ever announced once per alert.
import { HttpError, str } from './http.js';
import { dealPath } from './seo.js';

export const MAX_ALERTS = 10;
const HOUR = 3_600_000;
const LOOKBACK_MS = 26 * HOUR; // a missed run or two still catches up
const JOB_LOCK = 727275; // only one server instance runs the job at a time

/** The words of a phrase, lowercased: every one must start a word in the deal's title or store. */
export function phraseWords(phrase) {
  return String(phrase || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export function matchesPhrase(text, words) {
  const hay = ` ${String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')}`;
  return words.length > 0 && words.every((w) => hay.includes(` ${w}`));
}

function cleanPhrase(v) {
  const phrase = str(v, 'Alert', { required: true, min: 2, max: 60 }).replace(/\s+/g, ' ');
  if (!phraseWords(phrase).length) throw new HttpError(400, 'Use letters or numbers in your alert');
  return phrase;
}

const serializeAlert = (a) => ({ id: a.id, phrase: a.phrase, createdAt: a.created_at, updatedAt: a.updated_at, matches: a.matches ?? 0 });

export function registerAlertRoutes({ route, db }) {
  route('GET', '/api/alerts', { auth: true }, async ({ user }) => {
    const rows = await db.all(
      `SELECT a.*, (SELECT COUNT(*) FROM alert_hits h WHERE h.alert_id = a.id) AS matches
         FROM alerts a WHERE a.user_id = ? ORDER BY a.created_at DESC`,
      user.id,
    );
    return { items: rows.map(serializeAlert), max: MAX_ALERTS };
  });

  route('POST', '/api/alerts', { auth: true, active: true }, async ({ body, user }) => {
    const phrase = cleanPhrase(body.phrase);
    const { n } = await db.get('SELECT COUNT(*) AS n FROM alerts WHERE user_id = ?', user.id);
    if (n >= MAX_ALERTS) throw new HttpError(400, `You can have up to ${MAX_ALERTS} alerts. Delete one to add another.`);
    if (await db.get('SELECT 1 FROM alerts WHERE user_id = ? AND lower(phrase) = lower(?)', user.id, phrase)) {
      throw new HttpError(409, `You already have an alert for “${phrase}”`);
    }
    const now = Date.now();
    const row = await db.get('INSERT INTO alerts (user_id, phrase, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING *', user.id, phrase, now, now);
    return { alert: serializeAlert(row) };
  });

  route('PATCH', '/api/alerts/:id', { auth: true, active: true }, async ({ params, body, user }) => {
    const phrase = cleanPhrase(body.phrase);
    const id = Number(params.id);
    if (await db.get('SELECT 1 FROM alerts WHERE user_id = ? AND lower(phrase) = lower(?) AND id <> ?', user.id, phrase, id)) {
      throw new HttpError(409, `You already have an alert for “${phrase}”`);
    }
    // A changed phrase starts afresh: only deals posted from now on are announced for it.
    const now = Date.now();
    const row = await db.get('UPDATE alerts SET phrase = ?, updated_at = ?, created_at = ? WHERE id = ? AND user_id = ? RETURNING *', phrase, now, now, id, user.id);
    if (!row) throw new HttpError(404, 'Alert not found');
    await db.run('DELETE FROM alert_hits WHERE alert_id = ?', id);
    return { alert: serializeAlert(row) };
  });

  route('DELETE', '/api/alerts/:id', { auth: true }, async ({ params, user }) => {
    const r = await db.run('DELETE FROM alerts WHERE id = ? AND user_id = ?', Number(params.id), user.id);
    if (!r.changes) throw new HttpError(404, 'Alert not found');
    return { ok: true };
  });
}

/**
 * The hourly job: new matches for every alert, one push per user (the best deal when there's one,
 * a summary pointing at the Alerts tab when there are several). Returns what it did.
 */
export async function runAlertJob({ db, repo, push, log = console, now = Date.now() }) {
  const result = { alerts: 0, matches: 0, notified: 0, skipped: false };
  await db.tx(async () => {
    const { locked } = await db.get('SELECT pg_try_advisory_xact_lock(?) AS locked', JOB_LOCK);
    if (!locked) {
      result.skipped = true;
      return;
    }
    const alerts = await db.all("SELECT a.* FROM alerts a JOIN users u ON u.id = a.user_id WHERE u.status = 'active'");
    result.alerts = alerts.length;
    if (!alerts.length) return;
    const deals = await db.all(`${repo.DEAL_SELECT} WHERE d.status = 'active' AND d.created_at > ? ORDER BY d.created_at DESC LIMIT 2000`, now - LOOKBACK_MS);
    const perUser = new Map(); // user id → [{ alert, deal }]
    for (const a of alerts) {
      const words = phraseWords(a.phrase);
      for (const d of deals) {
        if (d.created_at <= a.created_at || d.submitted_by === a.user_id) continue;
        if (!matchesPhrase(`${d.title} ${d.best_store || ''}`, words)) continue;
        const fresh = await db.run('INSERT INTO alert_hits (alert_id, deal_id, matched_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', a.id, d.id, now);
        if (!fresh.changes) continue;
        result.matches++;
        if (!perUser.has(a.user_id)) perUser.set(a.user_id, []);
        perUser.get(a.user_id).push({ alert: a, deal: repo.serializeDeal(d) });
      }
    }
    for (const [userId, hits] of perUser) {
      const phrases = [...new Set(hits.map((h) => h.alert.phrase))];
      const first = hits[0].deal;
      const message =
        hits.length === 1
          ? {
              title: `New deal for “${phrases[0]}”`,
              body: `${first.title.length > 90 ? `${first.title.slice(0, 87)}…` : first.title}${first.discountPct ? ` · ${first.discountPct}% off` : ''}${first.store ? ` on ${first.store}` : ''}`,
              data: { url: dealPath(first), deal_id: String(first.id), kind: 'search_alert' },
            }
          : {
              title: `${hits.length} new deals for your alerts`,
              body: `Matching ${phrases.slice(0, 3).map((p) => `“${p}”`).join(', ')}${phrases.length > 3 ? ' and more' : ''}`,
              data: { url: '/alerts', deal_id: String(first.id), kind: 'search_alert' },
            };
      if (await push.sendToUser(userId, message, { dealId: first.id, kind: 'search_alert' })) result.notified++;
    }
  });
  if (result.matches) log.log?.(`[alerts] ${result.matches} new match(es), ${result.notified} user(s) notified`);
  return result;
}

/** Start the hourly job (production server only). */
export function scheduleAlertJob(deps) {
  const run = () => runAlertJob(deps).catch((err) => console.error('[alerts] job failed:', err.message));
  const first = setTimeout(run, 60_000); // a minute after boot, then every hour
  const every = setInterval(run, HOUR);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
