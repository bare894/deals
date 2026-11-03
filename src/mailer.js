// Outgoing email (password resets). Configured with SMTP_* variables, e.g. Zoho Mail:
// SMTP_HOST=smtp.zoho.com SMTP_PORT=465 SMTP_USER=info@sharedeals.in SMTP_PASS=<app password>
// SMTP_FROM="ShareDeals <info@sharedeals.in>". Without them, emails are only logged (local runs).
import nodemailer from 'nodemailer';

export function mailerFromEnv(env = process.env) {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
    return {
      configured: false,
      send: async ({ to, subject, text }) => console.log(`[mail] (not configured) to=${to} subject=${subject}\n${text}`),
    };
  }
  const port = Number(env.SMTP_PORT || 465);
  const transport = nodemailer.createTransport({ host: env.SMTP_HOST, port, secure: port === 465, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } });
  const from = env.SMTP_FROM || env.SMTP_USER;
  return { configured: true, send: ({ to, subject, text }) => transport.sendMail({ from, to, subject, text }) };
}
