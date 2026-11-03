// Deal alerts: Android push notifications (Firebase Cloud Messaging) when a newly posted deal
// matches what a user has shown interest in. App only: the Android app registers its FCM token
// for the signed-in user (POST /api/push/token); websites never do.
//
// Configured with FIREBASE_SERVICE_ACCOUNT: the JSON key of a service account in the Firebase
// project (Project settings → Service accounts → Generate new private key). Without it nothing
// is sent. Sends and failures are logged in push_log; when GA_API_SECRET is set each send is also
// recorded in Google Analytics as a `deal_alert_sent` event (Measurement Protocol). Opens are
// tracked by the app as `deal_alert_open`.
import { createSign } from 'node:crypto';
import { dealPath } from './seo.js';
import { ALERT_THRESHOLD, interestMatch, hasInterests } from './ranking.js';
import { cents } from './http.js';

const DAY = 24 * 3_600_000;
const MAX_ALERTS_PER_DAY = 6;
const GA_MEASUREMENT_ID = 'G-BSMZRCKB6Y';

const b64url = (s) => Buffer.from(s).toString('base64url');

export function createPush({ db, repo, env = process.env, fetchImpl = fetch, log = console }) {
  let account = null;
  try {
    account = env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(env.FIREBASE_SERVICE_ACCOUNT) : null;
  } catch {
    log.error('[push] FIREBASE_SERVICE_ACCOUNT is not valid JSON; deal alerts are off');
  }
  const enabled = Boolean(account?.client_email && account?.private_key && account?.project_id);

  // OAuth access token for the FCM API, from a self-signed service-account JWT (cached ~55 min).
  let accessToken = null;
  async function getAccessToken() {
    if (accessToken && accessToken.expires > Date.now() + 60_000) return accessToken.value;
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(
      JSON.stringify({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }),
    );
    const signature = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(account.private_key).toString('base64url');
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${signature}` }),
    });
    if (!res.ok) throw new Error(`token ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const { access_token, expires_in } = await res.json();
    accessToken = { value: access_token, expires: Date.now() + (expires_in || 3600) * 1000 };
    return access_token;
  }

  /** Send one message; returns 'sent', 'gone' (token no longer valid) or throws. */
  async function sendToToken(token, { title, body, data }) {
    const res = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await getAccessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          data,
          android: { priority: 'high', notification: { channel_id: 'deal_alerts', tag: `deal-${data.deal_id}` } },
        },
      }),
    });
    if (res.ok) return 'sent';
    const text = await res.text();
    if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT.*registration/i.test(text)) return 'gone';
    throw new Error(`FCM ${res.status}: ${text.slice(0, 200)}`);
  }

  async function gaEvent(userId, name, params) {
    if (!env.GA_API_SECRET) return;
    await fetchImpl(`https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${encodeURIComponent(env.GA_API_SECRET)}`, {
      method: 'POST',
      body: JSON.stringify({ client_id: `server.${userId}`, user_id: String(userId), events: [{ name, params }] }),
    }).catch(() => {});
  }

  /**
   * Push one message to every device a user has signed in on. Logs it (push_log, and GA's
   * `<kind>_sent` when GA_API_SECRET is set); drops tokens Firebase says are gone. Returns
   * whether any device took it.
   */
  async function sendToUser(userId, message, { dealId = null, kind = 'match' } = {}) {
    if (!enabled) return false;
    const tokens = await db.all('SELECT token FROM push_tokens WHERE user_id = ?', userId);
    if (!tokens.length) return false;
    let delivered = false;
    for (const { token } of tokens) {
      try {
        const result = await sendToToken(token, message);
        if (result === 'gone') await db.run('DELETE FROM push_tokens WHERE token = ?', token);
        else delivered = true;
      } catch (err) {
        log.error(`[push] ${kind} to user ${userId}: ${err.message}`);
      }
    }
    await db.run('INSERT INTO push_log (user_id, deal_id, status, sent_at, kind) VALUES (?, ?, ?, ?, ?)', userId, dealId, delivered ? 'sent' : 'failed', Date.now(), kind);
    if (delivered) await gaEvent(userId, kind === 'search_alert' ? 'search_alert_sent' : 'deal_alert_sent', { deal_id: dealId ?? 0 });
    return delivered;
  }

  /**
   * A deal was just posted: alert app users it's a strong match for. Skips the poster, anyone
   * who's already had MAX_ALERTS_PER_DAY alerts in the last 24 hours, and users with no
   * interests yet. Runs in the background; never throws.
   */
  async function notifyNewDeal(dealId) {
    if (!enabled) return { sent: 0 };
    let sent = 0;
    try {
      const row = await repo.getDealRow(dealId);
      if (!row || row.status !== 'active') return { sent };
      const deal = repo.serializeDeal(row);
      const users = await db.all(
        `SELECT DISTINCT t.user_id FROM push_tokens t JOIN users u ON u.id = t.user_id
          WHERE u.status = 'active' AND t.user_id <> ?
            AND (SELECT COUNT(*) FROM push_log l WHERE l.user_id = t.user_id AND l.kind = 'match' AND l.status = 'sent' AND l.sent_at > ?) < ?`,
        row.submitted_by, Date.now() - DAY, MAX_ALERTS_PER_DAY,
      );
      const price = deal.price === 0 ? 'FREE' : deal.price != null ? `₹${cents(row.best_price_cents).toLocaleString('en-IN')}` : '';
      const message = {
        title: deal.discountPct ? `${deal.discountPct}% off: a deal you might like` : 'A deal you might like',
        body: [deal.title.length > 90 ? `${deal.title.slice(0, 87)}…` : deal.title, [price, deal.store && `on ${deal.store}`].filter(Boolean).join(' ')].filter(Boolean).join('\n'),
        data: { url: dealPath(deal), deal_id: String(deal.id), kind: 'deal_alert' },
      };
      for (const { user_id: userId } of users) {
        const profile = await repo.userInterests(userId);
        if (!hasInterests(profile) || interestMatch(row, profile) < ALERT_THRESHOLD) continue;
        if (await sendToUser(userId, message, { dealId, kind: 'match' })) sent++;
      }
    } catch (err) {
      log.error(`[push] deal ${dealId}: ${err.message}`);
    }
    return { sent };
  }

  return { enabled, notifyNewDeal, sendToUser };
}
