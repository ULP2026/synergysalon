/**
 * The website's contact form (api/_lib/contact-form.js): a message saved on
 * the client record, and texting consent recorded only when the optional box
 * is ticked, with a number to text. The opt-in the salon's A2P 10DLC
 * registration describes, so these are the carriers' rules.
 *
 *   TEST_DATABASE_URL=postgres://… npm test
 *
 * In a ZZ salon made for the test and removed with it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { optInText, saveContactMessage, sendOptInConfirmation } from '../api/_lib/contact-form.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const isLocal = url?.includes('localhost') || url?.includes('127.0.0.1');

test('a contact message is saved, and consent only when the box is ticked with a number', { skip }, async () => {
  const c = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await c.connect();
  let tenantId = null;
  try {
    const { rows: [t] } = await c.query(
      "INSERT INTO tenants (slug, name) VALUES ($1, 'ZZ Contact Salon') RETURNING id", [`zz-contact-${Date.now()}`]);
    tenantId = t.id;
    const tenant = { id: tenantId };
    const row = async (email) => (await c.query(
      `SELECT name, phone, source, status, notes, to_jsonb(contacts) -> 'sms_ok' AS sms_ok
         FROM contacts WHERE tenant_id = $1 AND lower(email) = $2`, [tenantId, email])).rows[0];

    // No box ticked: saved as a new client, not textable, and the note says so.
    const a = await saveContactMessage(tenant, {
      name: 'ZZ Ana', email: 'ZZ-Ana@example.com', phone: '', message: 'Do you do balayage?', elapsed: 9000,
    });
    assert.equal(a.saved, true);
    let r = await row('zz-ana@example.com');
    assert.equal(r.source, 'Website contact form');
    assert.equal(r.status, 'new');
    assert.equal(r.sms_ok, false);
    assert.match(r.notes, /Website contact form \(synergysalon\.com\/sms-opt-in\): Do you do balayage\?/);
    assert.match(r.notes, /Text messages: not agreed/);

    // Again, ticked, with a number: the same client, consent on, newest note on top.
    await saveContactMessage(tenant, {
      name: 'ZZ Ana', email: 'zz-ana@example.com', phone: '+1 (813) 555-0142', message: 'Texts are fine', smsConsent: true, elapsed: 9000,
    });
    r = await row('zz-ana@example.com');
    assert.equal(r.sms_ok, true);
    assert.equal(r.phone, '8135550142');
    assert.match(r.notes, /^.*Texts are fine\nText messages: agreed \(ticked the optional consent box\) for 8135550142/);
    assert.match(r.notes, /Do you do balayage/, 'the earlier message is kept');
    assert.equal((await c.query('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1', [tenantId])).rows[0].n, 1);

    // An unticked box later never takes a yes away.
    await saveContactMessage(tenant, { name: 'ZZ Ana', email: 'zz-ana@example.com', message: 'One more thing', elapsed: 9000 });
    assert.equal((await row('zz-ana@example.com')).sms_ok, true);

    // Refused with a reason: consent with no number, a bad number, no email, no message.
    await assert.rejects(saveContactMessage(tenant, { name: 'ZZ B', email: 'zz-b@example.com', message: 'hi', smsConsent: true }), /Add your mobile number/);
    await assert.rejects(saveContactMessage(tenant, { name: 'ZZ B', email: 'zz-b@example.com', phone: '12345', message: 'hi' }), /10-digit US mobile/);
    await assert.rejects(saveContactMessage(tenant, { name: 'ZZ B', email: 'not-an-email', message: 'hi' }), /email address/);
    await assert.rejects(saveContactMessage(tenant, { name: 'ZZ B', email: 'zz-b@example.com', message: '' }), /Message is required/);

    // A bot: the hidden field filled, or sent faster than a person types. Told
    // "saved", and nothing is stored.
    assert.equal((await saveContactMessage(tenant, { name: 'ZZ Bot', email: 'zz-bot@example.com', message: 'x', company: 'Spam Inc' })).ignored, 'honeypot');
    assert.equal((await saveContactMessage(tenant, { name: 'ZZ Bot', email: 'zz-bot@example.com', message: 'x', elapsed: 400 })).ignored, 'too fast');
    assert.equal(await row('zz-bot@example.com'), undefined);
  } finally {
    if (tenantId) {
      await c.query('DELETE FROM contacts WHERE tenant_id = $1', [tenantId]);
      await c.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
    await c.end();
  }
});

test("ticking the box texts the carriers' opt-in confirmation, from Karen's number", { skip }, async () => {
  const text = optInText({ name: 'Synergy Salon' });
  assert.match(text, /^Synergy Salon: /, 'the brand first');
  for (const must of [/Msg frequency varies/, /Msg & data rates may apply/, /Reply HELP for help/, /STOP to opt out/]) assert.match(text, must);
  assert.ok(text.length <= 320, 'two texts at most');

  const client = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await client.connect();
  const saved = { sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN };
  let tenantId;
  try {
    ({ rows: [{ id: tenantId }] } = await client.query(
      "INSERT INTO tenants (slug, name, karen_phone) VALUES ('zz-optin-text', 'ZZ Opt-in Salon', '+18138514556') RETURNING id",
    ));
    const sent = [];
    const send = async (m) => { sent.push(m); };
    delete process.env.TWILIO_ACCOUNT_SID;
    assert.deepEqual(await sendOptInConfirmation({ id: tenantId, name: 'ZZ Opt-in Salon' }, '8135550142', send),
      { skipped: 'texting not connected' });
    process.env.TWILIO_ACCOUNT_SID = 'ACzz';
    process.env.TWILIO_AUTH_TOKEN = 'zz';
    await sendOptInConfirmation({ id: tenantId, name: 'ZZ Opt-in Salon' }, '8135550142', send);
    assert.deepEqual(sent, [{ to: '+18135550142', from: '+18138514556', body: optInText({ name: 'ZZ Opt-in Salon' }) }]);
  } finally {
    for (const [k, v] of [['TWILIO_ACCOUNT_SID', saved.sid], ['TWILIO_AUTH_TOKEN', saved.token]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (tenantId) await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    await client.end();
  }
});
