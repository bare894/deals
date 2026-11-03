// Feedback from the site and the Android app (/feedback). Signed-out visitors can send it too;
// moderators read it in Admin Mode → Feedback.
import { HttpError, str } from '../http.js';

const PLATFORMS = ['web', 'android'];

export function registerFeedbackRoutes({ route, db, rateLimit }) {
  route('POST', '/api/feedback', {}, async ({ req, body, user, ip }) => {
    rateLimit('feedback', user ? `u${user.id}` : ip);
    const message = str(body.message, 'Feedback', { required: true, min: 3, max: 4000 });
    const email = user ? user.email : str(body.email, 'Email', { max: 200 });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email, or leave it blank');
    await db.run(
      'INSERT INTO feedback (user_id, email, message, page, platform, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      user?.id ?? null, email || null, message, str(body.page, 'Page', { max: 300 }) || null,
      PLATFORMS.includes(body.platform) ? body.platform : 'web', String(req.headers['user-agent'] || '').slice(0, 300) || null, Date.now(),
    );
    return { ok: true };
  });
}
