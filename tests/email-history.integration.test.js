/**
 * Marketing's email history: every email the automations sent, newest first,
 * a page at a time (history() in api/staff/_routes/business.js).
 *
 *   TEST_DATABASE_URL=postgres://… npm test
 *
 * It reads through the shared pool, which only sees committed rows, so this
 * commits its own send-log rows. They belong to a ZZ salon made for the test
 * and go with it in the finally, so nothing of the salon's is read or left
 * behind -- and because the salon is its own, the counts are exact.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { history, sentMessage } from '../api/staff/_routes/business.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const isLocal = url?.includes('localhost') || url?.includes('127.0.0.1');

test('every email sent, newest first, paged without skipping or repeating', { skip }, async () => {
  const c = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await c.connect();
  let tenantId = null;
  try {
    const { rows: [t] } = await c.query(
      `INSERT INTO tenants (slug, name) VALUES ($1, 'ZZ History Salon') RETURNING id`,
      [`zz-history-${Date.now()}`],
    );
    tenantId = t.id;

    // 120 sends: 60 of them in one and the same instant, so a page boundary
    // is certain to fall inside a run of identical timestamps -- the case a
    // cursor on time alone gets wrong.
    await c.query(
      `INSERT INTO message_sends (tenant_id, kind, to_name, to_email, sent_at)
       SELECT $1, CASE WHEN g % 2 = 0 THEN 'reminder' ELSE 'confirmation' END,
              'ZZ Guest ' || g, 'zz-' || g || '@example.com',
              CASE WHEN g <= 60 THEN timestamptz '2026-10-01 10:00:00.123456+00'
                   ELSE timestamptz '2026-10-01 10:00:00+00' + make_interval(secs => g) END
         FROM generate_series(1, 120) g`,
      [tenantId],
    );

    const seen = [];
    let page = await history({ id: tenantId }, null);
    assert.equal(page.sends.length, 50, 'a page is 50');
    seen.push(...page.sends);
    while (page.next) {
      page = await history({ id: tenantId }, page.next);
      seen.push(...page.sends);
    }

    assert.equal(seen.length, 120, 'every email, once');
    assert.equal(new Set(seen.map((s) => s.email)).size, 120, 'none twice');
    const times = seen.map((s) => new Date(s.sentAt).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');
    assert.equal(seen[0].email, 'zz-120@example.com', 'the latest is at the top');
    assert.ok(seen.every((s) => ['reminder', 'confirmation'].includes(s.kind)));

    // Another salon's emails never appear, and a cursor that is not one is
    // read as "from the top" rather than as an error.
    const other = await history({ id: '00000000-0000-0000-0000-000000000000' }, null);
    assert.deepEqual(other, { sends: [], next: null });
    const junk = await history({ id: tenantId }, 'not-a-cursor');
    assert.equal(junk.sends[0].email, 'zz-120@example.com');
  } finally {
    if (tenantId) await c.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    await c.end();
  }
});

test('a sent email opens rebuilt from its booking, never with the guest’s own link', { skip }, async () => {
  const c = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await c.connect();
  let tenantId = null;
  try {
    const { rows: [t] } = await c.query(
      `INSERT INTO tenants (slug, name) VALUES ($1, 'ZZ Sent Salon') RETURNING id`,
      [`zz-sent-${Date.now()}`],
    );
    tenantId = t.id;
    const { rows: [st] } = await c.query(
      "INSERT INTO stylists (tenant_id, slug, name) VALUES ($1, 'zz-dee', 'ZZ Dee') RETURNING id", [tenantId]);
    const { rows: [sv] } = await c.query(
      `INSERT INTO services (tenant_id, slug, name, category, duration_min)
       VALUES ($1, 'zz-trim', 'ZZ Trim', 'cuts', 45) RETURNING id`, [tenantId]);
    const { rows: [a] } = await c.query(
      `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, starts_at, duration_min, buffer_min,
                                 during, guest_name, guest_email, manage_token, channel)
       VALUES ($1, 'ZZSENT', $2, $3, timestamptz '2026-11-03 15:00+00', 45, 0,
               tstzrange(timestamptz '2026-11-03 15:00+00', timestamptz '2026-11-03 15:45+00', '[)'),
               'ZZ Rosa', 'zz-rosa@example.com', 'the-real-secret-token', 'staff') RETURNING id`,
      [tenantId, st.id, sv.id]);
    const { rows: sends } = await c.query(
      `INSERT INTO message_sends (tenant_id, kind, appointment_id, to_name, to_email, sent_at)
       VALUES ($1, 'reminder', $2, 'ZZ Rosa', 'zz-rosa@example.com', now() - interval '2 minutes'),
              ($1, 'reschedule', NULL, 'ZZ Gone', 'zz-gone@example.com', now() - interval '1 minute')
       RETURNING id, kind`,
      [tenantId, a.id]);
    const id = (kind) => sends.find((s) => s.kind === kind).id;

    const page = await history({ id: tenantId }, null);
    assert.ok(page.sends.every((s) => sends.some((x) => x.id === s.id)), 'each row carries its id');

    const m = await sentMessage(id('reminder'), { id: tenantId, name: 'ZZ Sent Salon' });
    assert.equal(m.kind, 'reminder');
    assert.equal(m.to, 'ZZ Rosa <zz-rosa@example.com>');
    assert.equal(m.ref, 'ZZSENT');
    assert.match(m.html, /ZZ Trim/);
    assert.match(m.html, /ZZ Dee/);
    assert.ok(!m.html.includes('the-real-secret-token'), 'the guest’s manage token is never shown');
    assert.match(m.note, /record of each email, not a copy/);

    // A booking deleted since: the sample's details, the client's name, and a
    // reschedule that has no old time to show says so without a 1970 date.
    const gone = await sentMessage(id('reschedule'), { id: tenantId, name: 'ZZ Sent Salon' });
    assert.equal(gone.toName, 'ZZ Gone');
    assert.equal(gone.ref, null);
    assert.ok(!gone.html.includes('1970'), 'no epoch date');
    assert.match(gone.note, /deleted/);

    // Another salon's email, or no email at all, is not found.
    await assert.rejects(sentMessage(id('reminder'), { id: '00000000-0000-0000-0000-000000000000' }), /No such email/);
    await assert.rejects(sentMessage('not-an-id', { id: tenantId }), /No such email/);
  } finally {
    if (tenantId) {
      await c.query('DELETE FROM appointments WHERE tenant_id = $1', [tenantId]);
      await c.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
    await c.end();
  }
});
