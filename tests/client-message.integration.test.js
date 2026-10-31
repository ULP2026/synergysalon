/**
 * Writing to a client from their profile: a text from Karen's number,
 * signed, only to a client who agreed to texts; an email kept so it opens
 * again; both on their Activity. Nothing really goes out: Twilio and the
 * email provider are stand-ins. Test people are named ZZ and removed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { sentMessage } from '../api/staff/_routes/business.js';
import { contactDetail } from '../api/staff/_routes/contacts.js';
import { messageClient } from '../api/_lib/client-message.js';
import { DEFAULT_TZ } from '../api/_lib/config.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const isLocal = url?.includes('localhost') || url?.includes('127.0.0.1');

test('the team texts and emails a client from their profile', { skip }, async () => {
  const client = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await client.connect();
  const saved = {
    sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN, resend: process.env.RESEND_API_KEY,
    fetch: globalThis.fetch, resendClient: globalThis.__synergyResend,
  };
  let tenantId;
  try {
    ({ rows: [{ id: tenantId }] } = await client.query(
      "INSERT INTO tenants (slug, name, karen_phone, timezone) VALUES ($1, 'ZZ Message Salon', '+18138514556', $2) RETURNING id",
      [`zz-msg-${Date.now()}`, DEFAULT_TZ],
    ));
    const tenant = { id: tenantId, name: 'ZZ Message Salon', timezone: DEFAULT_TZ };
    const { rows: [agreed] } = await client.query(
      `INSERT INTO contacts (tenant_id, name, email, phone, sms_consent_at, sms_consent_phone)
       VALUES ($1, 'ZZ Agreed Client', 'zz-msg-agreed@example.com', '8135550171', now(), '8135550171') RETURNING id`,
      [tenantId],
    );
    const { rows: [notYet] } = await client.query(
      "INSERT INTO contacts (tenant_id, name, email, phone) VALUES ($1, 'ZZ Not Yet', '', '8135550172') RETURNING id",
      [tenantId],
    );
    const { rows: [user] } = await client.query(
      `INSERT INTO staff_users (tenant_id, name, email, role, password_hash)
       VALUES ($1, 'ZZ Luis Lara', $2, 'owner', 'x') RETURNING id, name`,
      [tenantId, `zz-msg-${Date.now()}@example.com`],
    );

    process.env.TWILIO_ACCOUNT_SID = 'ACzz';
    process.env.TWILIO_AUTH_TOKEN = 'zz';
    process.env.RESEND_API_KEY = 're_zz';
    const texts = [];
    globalThis.fetch = async (u, init) => { texts.push({ u: String(u), body: new URLSearchParams(String(init.body)) }); return { ok: true, json: async () => ({}) }; };
    const emails = [];
    globalThis.__synergyResend = { emails: { send: async (m) => { emails.push(m); return { data: { id: 'zz' }, error: null }; } } };

    // A text: from Karen's number, signed with the writer's first name, in plain characters.
    assert.deepEqual(await messageClient({ tenant, user, contactId: agreed.id, channel: 'sms', text: 'Your color is ready to book’s next step!' }, client), { sent: 'text' });
    assert.equal(texts.length, 1);
    assert.equal(texts[0].body.get('From'), '+18138514556');
    assert.equal(texts[0].body.get('To'), '+18135550171');
    assert.equal(texts[0].body.get('Body'), "ZZ at ZZ Message Salon: Your color is ready to book's next step!");

    // Not agreed to texts: refused, saying why, and nothing sent.
    await assert.rejects(
      messageClient({ tenant, user, contactId: notYet.id, channel: 'sms', text: 'hello' }, client),
      (err) => err.status === 409 && /haven't agreed to texts/.test(err.message),
    );
    // No email on file: refused too.
    await assert.rejects(
      messageClient({ tenant, user, contactId: notYet.id, channel: 'email', subject: 'Hi', text: 'hello' }, client),
      (err) => err.status === 409 && /no email address/.test(err.message),
    );
    assert.equal(texts.length, 1, 'no text to somebody who has not agreed');

    // An email: from the salon, with the subject and words written, kept to open again.
    assert.deepEqual(await messageClient({
      tenant, user, contactId: agreed.id, channel: 'email', subject: 'Your next visit', text: 'See you soon.\n\nBring your inspo photos!',
    }, client), { sent: 'email' });
    assert.equal(emails.length, 1);
    assert.equal(emails[0].to, 'zz-msg-agreed@example.com');
    assert.equal(emails[0].subject, 'Your next visit');
    assert.match(emails[0].text, /Hi ZZ,[\s\S]*See you soon\.[\s\S]*Bring your inspo photos![\s\S]*ZZ Luis Lara, ZZ Message Salon/);

    // Both on their Activity; the email opens again from its words.
    const d = await contactDetail(tenantId, agreed.id, client);
    const text = d.activity.find((e) => e.type === 'sms');
    assert.equal(text.title, 'Text from ZZ');
    assert.match(text.detail, /^ZZ at ZZ Message Salon: Your color/);
    const mail = d.activity.find((e) => e.type === 'email' && e.subject === 'Your next visit');
    assert.ok(mail?.sentId, 'the email is listed and opens');
    const opened = await sentMessage(mail.sentId, tenant);
    assert.equal(opened.kind, 'direct');
    assert.match(opened.html, /Bring your inspo photos!/);
    assert.equal(d.contact.messaging.text, null, 'can be texted');
    const other = await contactDetail(tenantId, notYet.id, client);
    assert.match(other.contact.messaging.text, /haven't agreed/);
    assert.match(other.contact.messaging.email, /no email address/);
  } finally {
    globalThis.fetch = saved.fetch;
    globalThis.__synergyResend = saved.resendClient;
    for (const [k, v] of [['TWILIO_ACCOUNT_SID', saved.sid], ['TWILIO_AUTH_TOKEN', saved.token], ['RESEND_API_KEY', saved.resend]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (tenantId) {
      await client.query('DELETE FROM message_sends WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM client_texts WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM contacts WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM staff_users WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
    await client.end();
  }
});
