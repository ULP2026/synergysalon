/**
 * Karen by text: she knows who is texting from their number, reads a
 * stylist's day, and cancels and moves a client's appointment through the
 * same rules as the manage page.
 *
 * Everything runs inside a transaction that is rolled back; test people are
 * named ZZ.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';
import pg from 'pg';

import { DEFAULT_TZ } from '../api/_lib/config.js';
import { karenReply, phoneKey, twilioSignatureOk } from '../api/_lib/karen-sms.js';
import { tenantForUser } from '../api/_lib/tenant.js';
import { makeBookable } from './bookable.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const isLocal = url?.includes('localhost') || url?.includes('127.0.0.1');

const STYLIST_PHONE = '+1 (813) 555-0177';
const CLIENT_PHONE = '813.555.0188';

test('a phone number is the same however it was typed', () => {
  assert.equal(phoneKey('+1 (813) 555-0177'), '8135550177');
  assert.equal(phoneKey('8135550177'), '8135550177');
  assert.equal(phoneKey('555-0177'), '');
});

test('only a request signed with the provider\'s token is trusted', async () => {
  const { createHmac } = await import('node:crypto');
  const params = { From: '+18135550177', To: '+18135550100', Body: 'hi' };
  const u = 'https://app.example.com/api/staff/karen-sms';
  const sig = createHmac('sha1', 'secret').update(u + 'Bodyhi' + 'From+18135550177' + 'To+18135550100').digest('base64');
  assert.equal(twilioSignatureOk(u, params, sig, 'secret'), true);
  assert.equal(twilioSignatureOk(u, { ...params, From: '+18135550188' }, sig, 'secret'), false);
  assert.equal(twilioSignatureOk(u, params, sig, ''), false, 'no token, no trust');
});

test('Karen greets people by name, reads a stylist\'s day, and cancels and moves a client\'s visit', { skip }, async () => {
  const client = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await client.connect();
  client.inTransaction = true;
  try {
    await client.query('BEGIN');
    const { rows: [t] } = await client.query("SELECT id FROM tenants WHERE slug = 'synergy'");
    const tenant = await tenantForUser({ tenant_id: t.id });
    const stylistId = await makeBookable(client, tenant.id, 'dina');
    const { rows: [svc] } = await client.query(
      "SELECT id, slug, duration_min FROM services WHERE tenant_id = $1 AND slug = 'haircuts'", [tenant.id],
    );

    // A stylist with a login and a phone, whose chair is Dina's.
    const { rows: [u] } = await client.query(
      `INSERT INTO staff_users (tenant_id, name, email, role, phone, password_hash)
       VALUES ($1, 'ZZ Stylist', 'zz-karen-stylist@example.com', 'stylist', $2, 'x') RETURNING id`,
      [tenant.id, STYLIST_PHONE],
    );
    await client.query('UPDATE stylists SET staff_user_id = $1 WHERE id = $2', [u.id, stylistId]);

    // A client, booked with her tomorrow at 2 PM and again in five days.
    const { rows: [c] } = await client.query(
      `INSERT INTO contacts (tenant_id, name, email, phone, status)
       VALUES ($1, 'ZZ Karen Client', 'zz-karen-client@example.com', $2, 'booked') RETURNING id`,
      [tenant.id, CLIENT_PHONE],
    );
    const book = async (ref, start) => {
      await client.query(
        `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, contact_id, starts_at, duration_min,
                                   buffer_min, during, guest_name, guest_email, manage_token)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, 0,
                 tstzrange($6::timestamptz, $6::timestamptz + make_interval(mins => $7::int), '[)'),
                 'ZZ Karen Client', 'zz-karen-client@example.com', $8)`,
        [tenant.id, ref, stylistId, svc.id, c.id, start.toISO(), svc.duration_min, `tok-${ref}`],
      );
    };
    const tomorrow = DateTime.now().setZone(DEFAULT_TZ).plus({ days: 1 }).startOf('day').set({ hour: 14 });
    await book('ZZKAR1', tomorrow);

    // The stylist: recognised, and her day read from the book.
    const day = await karenReply(tenant, STYLIST_PHONE, "What's on my schedule tomorrow?", client);
    assert.match(day, /^Hi ZZ!/);
    assert.match(day, /Tomorrow you have 1 appointment/);
    assert.match(day, /2:00 PM ZZ C\., Haircut/);

    // The client: recognised by name, and her one appointment cancelled
    // only after she says yes.
    const ask = await karenReply(tenant, '+18135550188', 'I need to cancel', client);
    assert.match(ask, /^Hi ZZ! Cancel your Haircuts? with Dina/);
    const kept = await karenReply(tenant, CLIENT_PHONE, 'no', client);
    assert.match(kept, /stays as it is/);
    assert.doesNotMatch(kept, /^Hi/, 'the greeting is once a conversation');
    await karenReply(tenant, CLIENT_PHONE, 'cancel', client);
    const done = await karenReply(tenant, CLIENT_PHONE, 'YES', client);
    assert.match(done, /is cancelled/);
    const { rows: [gone] } = await client.query("SELECT status FROM appointments WHERE ref = 'ZZKAR1'");
    assert.equal(gone.status, 'cancelled');

    // Moving: the next openings with the same stylist, and "1" takes the first.
    const later = DateTime.now().setZone(DEFAULT_TZ).plus({ days: 5 }).startOf('day').set({ hour: 15 });
    await book('ZZKAR2', later);
    const offers = await karenReply(tenant, CLIENT_PHONE, 'can I reschedule?', client);
    assert.match(offers, /Here are the next openings:\n1\. /);
    const moved = await karenReply(tenant, CLIENT_PHONE, '1', client);
    assert.match(moved, /All set! Your Haircuts? with Dina is now/);
    const { rows: [now] } = await client.query("SELECT starts_at, status FROM appointments WHERE ref = 'ZZKAR2'");
    assert.equal(now.status, 'booked');
    assert.notEqual(new Date(now.starts_at).getTime(), later.toMillis());

    // Somebody the salon does not know, asking to book while online booking is paused.
    const stranger = await karenReply(tenant, '+18135550199', 'Can I book a haircut?', client);
    assert.match(stranger, /^Hi! I'm Karen, the assistant at /);
    assert.match(stranger, /Booking by text opens soon/);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
