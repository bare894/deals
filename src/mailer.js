// Outgoing email (password resets).
//
// Zoho ZeptoMail (preferred; an HTTPS API, so it works on hosts that block SMTP, like Railway):
//   ZEPTOMAIL_TOKEN=<Send Mail token>  MAIL_FROM="ShareDeals <noreply@sharedeals.in>"
//   ZEPTOMAIL_URL=https://api.zeptomail.in/v1.1/email for accounts in Zoho's India data centre.
// Or SMTP: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM.
// With neither, emails are only logged (local runs).
import nodemailer from 'nodemailer';

/** "ShareDeals <info@sharedeals.in>" → { name, address } */
function parseFrom(s) {
  const m = String(s || '').match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  return m ? { name: m[1] || undefined, address: m[2].trim() } : { address: String(s || '').trim() };
}

export function mailerFromEnv(env = process.env, fetchImpl = fetch) {
  if (env.ZEPTOMAIL_TOKEN) {
    const url = env.ZEPTOMAIL_URL || 'https://api.zeptomail.com/v1.1/email';
    const token = env.ZEPTOMAIL_TOKEN.replace(/^Zoho-enczapikey\s+/i, '');
    const from = parseFrom(env.MAIL_FROM || env.SMTP_FROM || 'ShareDeals <noreply@sharedeals.in>');
    return {
      configured: true,
      async send({ to, subject, text }) {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Zoho-enczapikey ${token}` },
          body: JSON.stringify({ from, to: [{ email_address: { address: to } }], subject, textbody: text }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`ZeptoMail ${res.status}: ${(await res.text()).slice(0, 300)}`);
      },
    };
  }
  if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) {
    const port = Number(env.SMTP_PORT || 465);
    const transport = nodemailer.createTransport({
      host: env.SMTP_HOST, port, secure: port === 465, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    });
    const from = env.SMTP_FROM || env.SMTP_USER;
    return { configured: true, send: ({ to, subject, text }) => transport.sendMail({ from, to, subject, text }) };
  }
  return {
    configured: false,
    send: async ({ to, subject, text }) => console.log(`[mail] (not configured) to=${to} subject=${subject}\n${text}`),
  };
}

/**
 * New-signup notice to the site owner: one email per new account (password or Google/Facebook),
 * sent straight away. Recipient comes from SIGNUP_NOTIFY_EMAIL (kept out of the repo); unset = off.
 * Never blocks or fails the signup itself.
 */
export function signupNotifier({ mailer, to = process.env.SIGNUP_NOTIFY_EMAIL, log = console } = {}) {
  const recipient = String(to || '').trim();
  return function notifySignup({ email, handle, method }) {
    if (!recipient) return Promise.resolve(false);
    const when = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
    const text = `A new user registered on ShareDeals.\n\nEmail: ${email}\nUsername: @${handle}\nSigned up with: ${method}\nTime: ${when} IST\n`;
    return Promise.resolve()
      .then(() => mailer.send({ to: recipient, subject: `New ShareDeals signup: ${email}`, text }))
      .then(() => true)
      .catch((err) => {
        log.error(`[mail] signup notice failed: ${err.message}`);
        return false;
      });
  };
}
