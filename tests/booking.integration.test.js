/**
 * Proves the one claim that matters: the same slot cannot be sold twice.
 *
 * This needs a real Postgres, because the guarantee is not in our code — it is
 * the exclusion constraint in schema.sql. Application checks cannot provide
 * it: two requests can both read "free" before either writes.
 *
 *   DATABASE_URL=postgres://… node --test "tests/*.test.js"
 *
 * Without DATABASE_URL these tests skip rather than fail, so the unit suite
 * still runs on a machine with no database. Point it at a scratch database:
 * it creates and deletes its own rows, but it runs against whatever you give it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';
import pg from 'pg';

import { DEFAULT_TZ } from '../api/_lib/config.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';

const isLocal = url?.includes('localhost') || url?.includes('127.0.0.1');
const connect = () => new pg.Client({
  connectionString: url,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

/** A far-future slot, so it can never collide with real data. */
const START = DateTime.now().setZone(DEFAULT_TZ).plus({ years: 5 }).startOf('day').set({ hour: 11 });

/**
 * Inserts against the seeded tenant, resolving stylist and service by slug so
 * the test does not carry ids that change every time the seed is reloaded.
 */
function insert(client, { ref, stylist = 'dina', start = START, minutes = 60 }) {
  return client.query(
    `INSERT INTO appointments (
       tenant_id, ref, stylist_id, service_id, starts_at, duration_min, buffer_min,
       during, guest_name, guest_email, manage_token
     )
     SELECT t.id, $1, s.id, v.id, $3, $4, 0,
            tstzrange($3::timestamptz, $3::timestamptz + make_interval(mins => $4::int), '[)'),
            'Test Guest', 'test@example.com', $5
       FROM tenants t
       JOIN stylists s ON s.tenant_id = t.id AND s.slug = $2
       JOIN services v ON v.tenant_id = t.id AND v.slug = 'haircuts'
      WHERE t.slug = 'synergy'
     RETURNING id`,
    [ref, stylist, start.toISO(), minutes, `tok-${ref}`],
  );
}

async function cleanup(client) {
  await client.query("DELETE FROM appointments WHERE ref LIKE 'ZZTEST%'");
}

test('two simultaneous bookings for one slot: exactly one wins', { skip }, async () => {
  const a = connect();
  const b = connect();
  await a.connect();
  await b.connect();

  try {
    await cleanup(a);

    // Both transactions open, both believe the slot is free, then both write.
    // This is the race that application-level checking cannot see.
    await a.query('BEGIN');
    await b.query('BEGIN');

    await insert(a, { ref: 'ZZTESTA' });

    // b blocks here until a commits or rolls back, then the constraint decides.
    const contender = insert(b, { ref: 'ZZTESTB' }).then(
      () => 'inserted',
      (err) => err.code,
    );

    await a.query('COMMIT');
    const outcome = await contender;

    assert.equal(outcome, '23P01', 'the second booking is refused by the exclusion constraint');
    await b.query('ROLLBACK');

    const { rows } = await a.query(
      "SELECT count(*)::int AS n FROM appointments WHERE ref LIKE 'ZZTEST%' AND status = 'booked'",
    );
    assert.equal(rows[0].n, 1, 'exactly one appointment survives');
  } finally {
    await cleanup(a).catch(() => {});
    await a.end();
    await b.end();
  }
});

test('a partial overlap is refused too, not just an identical time', { skip }, async () => {
  const client = connect();
  await client.connect();
  try {
    await cleanup(client);
    await insert(client, { ref: 'ZZTESTC', minutes: 60 });

    // Starts half an hour in: different start time, same stylist, overlapping.
    const outcome = await insert(client, {
      ref: 'ZZTESTD', start: START.plus({ minutes: 30 }),
    }).then(() => 'inserted', (err) => err.code);

    assert.equal(outcome, '23P01');
  } finally {
    await cleanup(client).catch(() => {});
    await client.end();
  }
});

test('the same time with a different stylist is fine', { skip }, async () => {
  const client = connect();
  await client.connect();
  try {
    await cleanup(client);
    await insert(client, { ref: 'ZZTESTE', stylist: 'dina' });
    await insert(client, { ref: 'ZZTESTF', stylist: 'kim' });

    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM appointments WHERE ref LIKE 'ZZTEST%'",
    );
    assert.equal(rows[0].n, 2, 'four chairs means four concurrent appointments');
  } finally {
    await cleanup(client).catch(() => {});
    await client.end();
  }
});

test('cancelling genuinely frees the slot', { skip }, async () => {
  const client = connect();
  await client.connect();
  try {
    await cleanup(client);
    const { rows } = await insert(client, { ref: 'ZZTESTG' });

    // While it is live, the slot is blocked.
    const blocked = await insert(client, { ref: 'ZZTESTH' })
      .then(() => 'inserted', (err) => err.code);
    assert.equal(blocked, '23P01');

    await client.query("UPDATE appointments SET status = 'cancelled' WHERE id = $1", [rows[0].id]);

    // The constraint only applies to live bookings, so the slot is sellable.
    await insert(client, { ref: 'ZZTESTI' });
    const { rows: live } = await client.query(
      "SELECT count(*)::int AS n FROM appointments WHERE ref LIKE 'ZZTEST%' AND status = 'booked'",
    );
    assert.equal(live[0].n, 1);
  } finally {
    await cleanup(client).catch(() => {});
    await client.end();
  }
});
