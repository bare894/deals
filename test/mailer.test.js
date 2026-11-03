import test from 'node:test';
import assert from 'node:assert/strict';
import { mailerFromEnv } from '../src/mailer.js';

test('ZeptoMail: posts the email to the API with the token', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => (calls.push({ url, opts }), { ok: true, status: 201 });
  const m = mailerFromEnv({ ZEPTOMAIL_TOKEN: 'Zoho-enczapikey abc123', MAIL_FROM: 'ShareDeals <noreply@sharedeals.in>' }, fetchImpl);
  assert.equal(m.configured, true);
  await m.send({ to: 'a@b.test', subject: 'Hi', text: 'Body' });
  assert.equal(calls[0].url, 'https://api.zeptomail.com/v1.1/email');
  assert.equal(calls[0].opts.headers.authorization, 'Zoho-enczapikey abc123');
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body.from, { name: 'ShareDeals', address: 'noreply@sharedeals.in' });
  assert.equal(body.to[0].email_address.address, 'a@b.test');
  assert.equal(body.textbody, 'Body');
});

test('ZeptoMail: API errors are thrown', async () => {
  const m = mailerFromEnv({ ZEPTOMAIL_TOKEN: 'x' }, async () => ({ ok: false, status: 401, text: async () => 'bad token' }));
  await assert.rejects(m.send({ to: 'a@b.test', subject: 's', text: 't' }), /ZeptoMail 401: bad token/);
});

test('no mail settings: not configured', () => {
  assert.equal(mailerFromEnv({}).configured, false);
});
