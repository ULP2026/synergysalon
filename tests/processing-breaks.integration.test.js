/**
 * Processing breaks, end to end against Postgres: a color's Break frees its
 * stylist for somebody else, in what is offered and in what the database
 * accepts, and every booking is as long as the stylist says the work takes.
 *
 *   DATABASE_URL=postgres://… node --test "tests/*.test.js"
 *
 * Runs against the seeded tenant (db/seed.sql) with migrations applied,
 * inside transactions it rolls back. Test rows are named ZZ.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';
import pg from 'pg';

import { availableSlots } from '../api/_lib/availability.js';
import { createBooking } from '../api/_lib/booking.js';
import { EXCLUSION_VIOLATION } from '../api/_lib/db.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const isLocal = url?.includes('localhost') || url?.includes('127.0.0.1');
const connect = async () => {
  const c = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await c.connect();
  return c;
};

/** A Tuesday three to four weeks out: inside the booking horizon, 9 to 3 in the seed. */
function tuesday(zone) {
  let d = DateTime.now().setZone(zone).plus({ days: 21 }).startOf('day');
  while (d.weekday !== 2) d = d.plus({ days: 1 });
  return d;
}

const times = (days) => days.flatMap((d) => d.slots).map((s) => DateTime.fromISO(s.start).toMillis());

/** Dina's own figures: highlights 60 + 45 processing + 60, color 30 + 30 + 30. */
const DINA = {
  color: { on: true, start: 30, break: 30, finish: 30, highlights: { start: 60, break: 45, finish: 60 } },
};

async function setup(c, details = DINA) {
  const { rows } = await c.query("SELECT id, slug, name, timezone FROM tenants WHERE slug = 'synergy'");
  const tenant = rows[0];
  await c.query(
    "UPDATE stylists SET service_details = $2::jsonb WHERE tenant_id = $1 AND slug = 'dina'",
    [tenant.id, JSON.stringify(details)],
  );
  return tenant;
}

const book = (c, tenant, serviceSlug, start, name, extra = {}) => createBooking(c, tenant, {
  serviceSlug, stylistSlug: 'dina', start: start.toISO(), guestName: name,
  guestPhone: '8135550101', channel: 'staff', minLeadMin: 0, ...extra,
});

const slotsFor = async (c, tenant, day, serviceSlug, extra = {}) => new Set(times((await availableSlots(c, tenant, {
  serviceSlug, stylistSlug: 'dina', fromDate: day.toISODate(), toDate: day.toISODate(), minLeadMin: 0, ...extra,
})).days));

test("a color's Break is bookable with its stylist; its Start and Finish are not", { skip }, async () => {
  const c = await connect();
  try {
    await c.query('BEGIN');
    const tenant = await setup(c);
    const day = tuesday(tenant.timezone);
    const at = (h, m = 0) => day.set({ hour: h, minute: m });

    // Balayage is timed by Dina's Highlights: 60 + 45 + 60 = 165 minutes,
    // processing 11:00 to 11:45, booked as she does it, not the table's 180.
    const color = await book(c, tenant, 'balayage', at(10), 'ZZ Balayage');
    assert.equal(color.duration_min, 165);
    assert.deepEqual(color.breaks, [[60, 45]]);

    // A bang trim (15 minutes, 5 to clean down) fits inside the Break.
    const offered = await slotsFor(c, tenant, day, 'bang-trim');
    assert.ok(offered.has(at(11).toMillis()), '11:00 is in the Break');
    assert.ok(offered.has(at(11, 15).toMillis()), '11:15 ends at 11:35 with its clean-down');
    assert.ok(!offered.has(at(10, 45).toMillis()), '10:45 runs into the Start');
    assert.ok(!offered.has(at(11, 30).toMillis()), '11:30 runs into the Finish');
    assert.ok(!offered.has(at(12).toMillis()), '12:00 is the Finish');
    // A haircut (60 and 10) is longer than the Break, so it is not offered in it.
    assert.ok(!(await slotsFor(c, tenant, day, 'haircuts')).has(at(11).toMillis()));

    // The database agrees: the trim in the Break is accepted...
    const trim = await book(c, tenant, 'bang-trim', at(11, 15), 'ZZ Trim');
    assert.equal(trim.duration_min, 15);

    // ...and anything touching the Finish is refused by the constraint itself,
    // whatever the code above it thinks.
    const { rows: ids } = await c.query(
      "SELECT stylist_id, service_id FROM appointments WHERE ref = $1", [color.ref]);
    await c.query('SAVEPOINT clash');
    await assert.rejects(c.query(
      `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, starts_at, duration_min, buffer_min,
                                 during, guest_name, guest_phone, channel, manage_token)
       VALUES ($1, 'ZZCLASH1', $2, $3, $4::timestamptz, 20, 0,
               tstzrange($4::timestamptz, $4::timestamptz + interval '20 minutes', '[)'),
               'ZZ Clash', '8135550101', 'staff', 'zz-clash-token')`,
      [tenant.id, ids[0].stylist_id, ids[0].service_id, at(11, 40).toISO()],
    ), (err) => err.code === EXCLUSION_VIOLATION);
    await c.query('ROLLBACK TO SAVEPOINT clash');

    // Moving the color carries its Break with it: the trim is now in its Start.
    await c.query('SAVEPOINT move');
    await assert.rejects(c.query(
      `UPDATE appointments SET starts_at = $2::timestamptz,
              during = tstzrange($2::timestamptz, $2::timestamptz + make_interval(mins => duration_min + buffer_min), '[)')
        WHERE ref = $1`,
      [color.ref, at(10, 30).toISO()],
    ), (err) => err.code === EXCLUSION_VIOLATION);
    await c.query('ROLLBACK TO SAVEPOINT move');
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});

test("bookings are as long as the stylist says the work takes, alone and together", { skip }, async () => {
  const c = await connect();
  try {
    await c.query('BEGIN');
    const tenant = await setup(c, { ...DINA, cuts: { on: true, duration: 30 } });
    const day = tuesday(tenant.timezone);
    const at = (h, m = 0) => day.set({ hour: h, minute: m });

    // Her own Cuts figure, not the table's 60.
    const cut = await book(c, tenant, 'haircuts', at(9), 'ZZ Cut');
    assert.equal(cut.duration_min, 30);
    // Single process color: Color's 30 + 30 + 30.
    const single = await book(c, tenant, 'single-process-color', at(13), 'ZZ Single');
    assert.equal(single.duration_min, 90);
    assert.deepEqual(single.breaks, [[30, 30]]);

    // A cut then a balayage, one appointment: 30, the cut's 10-minute
    // clean-down, then 165, the processing 30 + 10 + 60 = 100 minutes in.
    await c.query('DELETE FROM appointments WHERE ref = ANY($1)', [[cut.ref, single.ref]]);
    const both = await book(c, tenant, 'haircuts', at(9), 'ZZ Both', { extraServiceSlugs: ['balayage'] });
    assert.equal(both.duration_min, 30 + 10 + 165);
    assert.deepEqual(both.breaks, [[100, 45]]);
    // Its Break is open: 10:40 to 11:25 holds a bang trim, which is a Cut,
    // so 30 minutes with Dina and 5 to clean down.
    assert.ok((await slotsFor(c, tenant, day, 'bang-trim')).has(at(10, 45).toMillis()));

    // A stylist who has typed nothing is booked at the table's length.
    const micah = await createBooking(c, tenant, {
      serviceSlug: 'balayage', stylistSlug: 'micah', start: at(10).toISO(), guestName: 'ZZ Table',
      guestPhone: '8135550101', channel: 'staff', minLeadMin: 0,
    });
    assert.equal(micah.duration_min, 180);
    assert.deepEqual(micah.breaks, []);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});
