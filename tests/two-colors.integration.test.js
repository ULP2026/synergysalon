/**
 * Two colors on one visit share the processing break (ClickUp 1k58pwrcvmy,
 * item 4): the second color is applied while the first develops, not after
 * it. Against Postgres, in a transaction rolled back at the end, with ZZ
 * guests only.
 *
 * Dina's figures here: Color 45/45/45 (Single Process with nothing typed is
 * the same), Partial Highlights 30/30/30. So a Single Process with a Partial
 * Highlights at 10:00 is:
 *   10:00-10:45 Single Process applied
 *   10:45-11:15 Partial Highlights applied (inside the Single Process break)
 *   11:15-11:30 open: both processing, Dina free
 *   11:30-12:15 Single Process finished (processed 10:45-11:30, its 45)
 *   12:15-12:45 Partial Highlights finished (processed 11:15-11:45, at least its 30)
 * 165 minutes, where end to end it was 135 + 90 = 225.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';
import pg from 'pg';

import { availableSlots } from '../api/_lib/availability.js';
import { createBooking } from '../api/_lib/booking.js';
import { EXCLUSION_VIOLATION } from '../api/_lib/db.js';
import { makeBookable } from './bookable.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const isLocal = url?.includes('localhost') || url?.includes('127.0.0.1');
const connect = async () => {
  const c = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await c.connect();
  return c;
};

/** A Tuesday three to four weeks out: inside the horizon, 9 to 3 in the seed. */
function tuesday(zone) {
  let d = DateTime.now().setZone(zone).plus({ days: 21 }).startOf('day');
  while (d.weekday !== 2) d = d.plus({ days: 1 });
  return d;
}

const DINA = {
  lunch: false,
  color: { on: true, start: 45, break: 45, finish: 45, partial: { start: 30, break: 30, finish: 30 } },
};

async function setup(c, details = DINA) {
  const { rows } = await c.query("SELECT id, slug, name, timezone FROM tenants WHERE slug = 'synergy'");
  const tenant = rows[0];
  await makeBookable(c, tenant.id, 'dina');
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

const offered = async (c, tenant, day, serviceSlug, extra = {}) => new Set((await availableSlots(c, tenant, {
  serviceSlug, stylistSlug: 'dina', fromDate: day.toISODate(), toDate: day.toISODate(), minLeadMin: 0, ...extra,
})).days.flatMap((d) => d.slots).map((s) => DateTime.fromISO(s.start).toMillis()));

test('the second color is applied in the first one\'s break, and the book holds only the work', { skip }, async () => {
  const c = await connect();
  try {
    await c.query('BEGIN');
    const tenant = await setup(c);
    const day = tuesday(tenant.timezone);
    const at = (h, m = 0) => day.set({ hour: h, minute: m });

    // What availability says the visit is, before anything is booked.
    const found = await availableSlots(c, tenant, {
      serviceSlug: 'single-process-color', extraServiceSlugs: ['partial-highlights'], stylistSlug: 'dina',
      fromDate: day.toISODate(), toDate: day.toISODate(), minLeadMin: 0,
    });
    assert.equal(found.visit.durationMin, 165, 'not 225 end to end');
    assert.deepEqual(found.visit.breaks, [[75, 15]]);

    const visit = await book(c, tenant, 'single-process-color', at(10), 'ZZ Two Colors',
      { extraServiceSlugs: ['partial-highlights'] });
    assert.equal(visit.duration_min, 165);
    assert.deepEqual(visit.breaks, [[75, 15]]);

    // A 15-minute bang trim fits the open 11:15 to 11:30 and nothing else
    // inside the visit: both applications and both finishes are held.
    const trims = await offered(c, tenant, day, 'bang-trim');
    assert.ok(trims.has(at(11, 15).toMillis()), '11:15 is the open time');
    for (const [h, m] of [[10, 0], [10, 30], [10, 45], [11, 0], [11, 30], [12, 0], [12, 30]]) {
      assert.ok(!trims.has(at(h, m).toMillis()), `${h}:${m || '00'} is Dina working on the colors`);
    }
    // Back to back after it still works: the visit ends at 12:45.
    assert.ok(trims.has(at(12, 45).toMillis()), '12:45 is the minute it ends');

    // The database agrees: a trim in the open time is accepted...
    await book(c, tenant, 'bang-trim', at(11, 15), 'ZZ Trim In Break');
    // ...and one written straight in over the second application is refused.
    const { rows: ids } = await c.query('SELECT stylist_id, service_id FROM appointments WHERE ref = $1', [visit.ref]);
    await c.query('SAVEPOINT clash');
    await assert.rejects(c.query(
      `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, starts_at, duration_min, buffer_min,
                                 during, guest_name, guest_phone, channel, manage_token)
       VALUES ($1, 'ZZCLASH2', $2, $3, $4::timestamptz, 15, 0,
               tstzrange($4::timestamptz, $4::timestamptz + interval '15 minutes', '[)'),
               'ZZ Clash', '8135550101', 'staff', 'zz-clash-token-2')`,
      [tenant.id, ids[0].stylist_id, ids[0].service_id, at(10, 50).toISO()],
    ), (err) => err.code === EXCLUSION_VIOLATION);
    await c.query('ROLLBACK TO SAVEPOINT clash');
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});

test('a color with no break, and a cut, stay end to end around the shared colors', { skip }, async () => {
  const c = await connect();
  try {
    await c.query('BEGIN');
    // The gloss ticked "No break" (30 minutes): with no break of its own it
    // has none to share. Left as Dina's Color figures it would have one, and
    // join the colors.
    const tenant = await setup(c, { ...DINA, items: { 'gloss-or-toner': { noBreak: true, duration: 30 } } });
    const day = tuesday(tenant.timezone);
    const found = await availableSlots(c, tenant, {
      serviceSlug: 'gloss-or-toner', extraServiceSlugs: ['single-process-color', 'womens-cut', 'partial-highlights'],
      stylistSlug: 'dina', fromDate: day.toISODate(), toDate: day.toISODate(), minLeadMin: 0,
    });
    // Women's Cut first (60, the table's: Dina typed no Cuts time), then the
    // gloss (30, no break) where it was picked, then the two colors together.
    assert.deepEqual(found.visit.names, ["Women's Cut", 'Gloss or Toner', 'Single Process Color', 'Partial Highlights']);
    const cut = found.visit.lines[0].durationMin;
    const gloss = found.visit.lines[1].durationMin;
    assert.equal(found.visit.durationMin, cut + gloss + 165);
    assert.deepEqual(found.visit.breaks, [[cut + gloss + 75, 15]]);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});
