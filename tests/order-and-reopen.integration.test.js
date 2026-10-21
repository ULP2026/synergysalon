/**
 * Two fixes from Luis's review of the processing-break change, against
 * Postgres, so the exclusion constraint has its say as well as the code:
 *
 *   - the order bug: a colour must be bookable around a filler already in
 *     its break, and movable once its break is filled;
 *   - staff "reopen" of a cancelled booking asks the same free-time question
 *     as every other way of booking, instead of relying on the constraint.
 *
 *   TEST_DATABASE_URL=postgres://… npm test
 *
 * Inside transactions it rolls back; nothing outlives the test. Its own
 * Tuesday, eight weeks out, so it never competes with the other files for
 * Dina's chair while they run at the same time.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';
import pg from 'pg';

import { availableSlots } from '../api/_lib/availability.js';
import { createBooking } from '../api/_lib/booking.js';
import { assertStillFree } from '../api/staff/_routes/appointment.js';
import { makeBookable } from './bookable.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const isLocal = url?.includes('localhost') || url?.includes('127.0.0.1');

async function connect() {
  const c = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await c.connect();
  return c;
}

function tuesday(zone, weeks) {
  let d = DateTime.now().setZone(zone).plus({ weeks }).startOf('day');
  while (d.weekday !== 2) d = d.plus({ days: 1 });
  return d;
}

/** Dina's highlights: 60 + 45 processing + 60, so a 10:00 balayage is free 11:00 to 11:45. */
async function setup(c) {
  const { rows: [tenant] } = await c.query("SELECT id, slug, name, timezone FROM tenants WHERE slug = 'synergy'");
  await makeBookable(c, tenant.id, 'dina');
  await c.query(
    "UPDATE stylists SET service_details = $2::jsonb WHERE tenant_id = $1 AND slug = 'dina'",
    [tenant.id, JSON.stringify({ color: { on: true, start: 30, break: 30, finish: 30, highlights: { start: 60, break: 45, finish: 60 } } })],
  );
  return tenant;
}

const book = (c, tenant, serviceSlug, start, name) => createBooking(c, tenant, {
  serviceSlug, stylistSlug: 'dina', start: start.toISO(), guestName: name,
  guestPhone: '8135550102', channel: 'staff', minLeadMin: 0,
});

/** The appointment as the staff route reads it, slugs and all. */
async function asRouteSeesIt(c, id) {
  const { rows } = await c.query(
    `SELECT a.*, s.slug AS stylist_slug, v.slug AS service_slug
       FROM appointments a JOIN stylists s ON s.id = a.stylist_id JOIN services v ON v.id = a.service_id
      WHERE a.id = $1`,
    [id],
  );
  return rows[0];
}

test('the order does not matter: a filler first, then the colour around it, then moving the colour', { skip }, async () => {
  const c = await connect();
  try {
    await c.query('BEGIN');
    const tenant = await setup(c);
    const day = tuesday(tenant.timezone, 8);
    const at = (h, m = 0) => day.set({ hour: h, minute: m });

    // The filler first: a 45-minute blowout at 11:00, its 10 minutes of
    // turnaround running to 11:55.
    const filler = await book(c, tenant, 'blowouts', at(11), 'ZZ Filler');
    assert.equal(filler.duration_min, 45);

    // Then the balayage at 10:00, whose Break is 11:00 to 11:45 -- exactly
    // the filler. Refused before the fix, by the code; the database never
    // minded, because it compares guest time.
    const colour = await book(c, tenant, 'balayage', at(10), 'ZZ Colour');
    assert.deepEqual(colour.breaks, [[60, 45]]);

    // And the guest with the colour can be offered their own time back.
    const { days } = await availableSlots(c, tenant, {
      serviceSlug: 'balayage', stylistSlug: 'dina', minLeadMin: 0,
      fromDate: day.toISODate(), toDate: day.toISODate(),
      excludeAppointmentId: colour.id,
      length: { durationMin: colour.duration_min, bufferMin: 15, breaks: colour.breaks },
    });
    const offered = days.flatMap((d) => d.slots).map((s) => DateTime.fromISO(s.start).toMillis());
    assert.ok(offered.includes(at(10).toMillis()), 'the colour can be moved onto its own time');
    // Not anywhere the filler would stop being inside the break.
    assert.ok(!offered.includes(at(10, 15).toMillis()), '10:15 puts the filler in the Start');
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});

test('reopen asks the same free-time question as a booking', { skip }, async () => {
  const c = await connect();
  try {
    await c.query('BEGIN');
    const tenant = await setup(c);
    const day = tuesday(tenant.timezone, 9);
    const at = (h) => day.set({ hour: h });

    // A haircut at 10:00 (60 minutes, 10 to turn round), cancelled.
    const cut = await book(c, tenant, 'haircuts', at(10), 'ZZ Reopen');
    await c.query("UPDATE appointments SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [cut.id]);

    // Free again: reopening is allowed.
    await assertStillFree(c, tenant, await asRouteSeesIt(c, cut.id));

    // Somebody takes 11:00. The two guests never meet -- 10:00 to 11:00 and
    // 11:00 onwards -- so the database would let the reopen through, which
    // is what it used to do. But there is no time to turn the station round,
    // which no other way of booking would have sold.
    await book(c, tenant, 'haircuts', at(11), 'ZZ Took It');
    await assert.rejects(
      assertStillFree(c, tenant, await asRouteSeesIt(c, cut.id)),
      (err) => err.status === 409 && /not free any more/.test(err.message),
    );
    // The proof that this is new: the constraint alone accepts it.
    await c.query('SAVEPOINT constraint_only');
    await c.query("UPDATE appointments SET status = 'booked', cancelled_at = NULL WHERE id = $1", [cut.id]);
    await c.query('ROLLBACK TO SAVEPOINT constraint_only');

    // A past appointment is history being corrected, not a slot to sell:
    // it is not asked about free time at all.
    const later = DateTime.fromJSDate(new Date(cut.starts_at)).plus({ hours: 1 }).toJSDate();
    await assertStillFree(c, tenant, await asRouteSeesIt(c, cut.id), later);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});
