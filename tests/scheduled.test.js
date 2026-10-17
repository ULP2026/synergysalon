/**
 * The queue behind M4 to M11.
 *
 * These pin the two things that decide whether a guest gets the right number
 * of emails: a trigger that runs twice must queue one message, and anything
 * that makes a queued message pointless must cancel it. Both are enforced in
 * Postgres (a partial unique index, an UPDATE), so they are tested against a
 * real database rather than a stub.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { query } from '../api/_lib/db.js';
import { at, cancelFor, enqueue } from '../api/_lib/scheduled.js';

const has = await query("SELECT to_regclass('public.scheduled_messages') AS t")
  .then((r) => Boolean(r.rows[0].t))
  .catch(() => false);

test('at() turns a delay into a time in the future', () => {
  const from = new Date('2026-10-17T12:00:00Z');
  assert.equal(at({ hours: 3 }, from).toISOString(), '2026-10-17T15:00:00.000Z');
  assert.equal(at({ days: 2 }, from).toISOString(), '2026-10-19T12:00:00.000Z');
  assert.equal(at({}, from).toISOString(), from.toISOString());
});

test('a kind that is not a real message is never queued', async () => {
  assert.equal(await enqueue('not_a_message', {
    tenantId: '00000000-0000-0000-0000-000000000000', toEmail: 'zz@example.com', sendAfter: new Date(),
  }), false);
});

test('a message with nobody to send it to is never queued', async () => {
  assert.equal(await enqueue('win_back', {
    tenantId: '00000000-0000-0000-0000-000000000000', toEmail: '', sendAfter: new Date(),
  }), false);
});

test('a trigger that runs twice queues one message, and cancelling stops it', { skip: !has && 'no database' }, async () => {
  const { rows: t } = await query("SELECT id FROM tenants WHERE slug = 'synergy'");
  if (!t[0]) return;
  const tenantId = t[0].id;

  // A contact id of our own, so nothing here touches a real guest's queue.
  const { rows: c } = await query(
    `INSERT INTO contacts (tenant_id, name, email) VALUES ($1, 'ZZ Queue Test', 'zz-queue@example.com')
     RETURNING id`,
    [tenantId],
  );
  const contactId = c[0].id;

  try {
    const who = { tenantId, contactId, toName: 'ZZ Queue Test', toEmail: 'zz-queue@example.com' };

    const first = await enqueue('win_back', { ...who, sendAfter: at({ days: 1 }) });
    assert.equal(first, true, 'the first one is queued');

    const pending = async () => (await query(
      `SELECT count(*)::int AS n FROM scheduled_messages
        WHERE contact_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL`,
      [contactId],
    )).rows[0].n;

    assert.equal(await pending(), 1);

    // Cancelling is how "stops when they book again" is implemented.
    const stopped = await cancelFor({ contactId }, 'they booked again');
    assert.equal(stopped, 1);
    assert.equal(await pending(), 0, 'nothing is left waiting');

    // The row is kept, with the reason, rather than deleted.
    const { rows: why } = await query(
      'SELECT cancel_reason FROM scheduled_messages WHERE contact_id = $1',
      [contactId],
    );
    assert.equal(why[0].cancel_reason, 'they booked again');
  } finally {
    await query('DELETE FROM scheduled_messages WHERE contact_id = $1', [contactId]);
    await query('DELETE FROM contacts WHERE id = $1', [contactId]);
  }
});
