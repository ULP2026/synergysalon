/**
 * Online, a stylist is offered only the times CENTRO says they are free.
 *
 *   DATABASE_URL=postgres://… node --test "tests/*.test.js"
 *
 * Skips without DATABASE_URL. Runs in a throwaway ZZ tenant with CENTRO
 * stubbed out, and removes it afterwards.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';

import { availableSlots } from '../api/_lib/availability.js';
import { createBooking } from '../api/_lib/booking.js';
import { pool } from '../api/_lib/db.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const TZ = 'America/New_York';

// A Saturday well ahead, so lead time and the 90-day horizon never interfere.
let DAY = DateTime.now().setZone(TZ).plus({ days: 20 }).startOf('day');
while (DAY.weekday !== 6) DAY = DAY.plus({ days: 1 });
const at = (h, m = 0) => DAY.set({ hour: h, minute: m });

/** CENTRO for the test: Tami works 10:00 to 12:00 that day, nothing else. */
function stubCentro() {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (href) => {
    const u = new URL(href);
    calls.push(u.pathname + u.search);
    if (u.pathname === '/calendars/zz-cal') {
      return Response.json({ calendar: { id: 'zz-cal', slotDuration: 30, slotDurationUnit: 'mins', teamMembers: [{ userId: 'zz-tami' }] } });
    }
    if (u.pathname === '/calendars/zz-cal/free-slots') {
      const slots = u.searchParams.get('userId') === 'zz-tami'
        ? [10, 10.5, 11, 11.5].map((h) => at(Math.floor(h), (h % 1) * 60).toISO())
        : [];
      return Response.json({ [DAY.toISODate()]: { slots }, traceId: 't' });
    }
    return Response.json({});
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function setup() {
  const db = pool();
  const t = (await db.query(
    `INSERT INTO tenants (slug, name, timezone, ghl_location_id, ghl_token, ghl_calendar_id)
     VALUES ('zz-hours', 'ZZ Hours', $1, 'zz-loc', 'zz-token', 'zz-cal') RETURNING id, slug, timezone`, [TZ],
  )).rows[0];
  const v = (await db.query(
    `INSERT INTO services (tenant_id, slug, name, category, duration_min, buffer_min)
     VALUES ($1, 'zz-cut', 'ZZ Cut', 'cut', 60, 15) RETURNING id`, [t.id],
  )).rows[0].id;
  for (const [slug, name, ghl] of [['zz-tami', 'ZZ Tami', 'zz-tami'], ['zz-kim', 'ZZ Kim', null]]) {
    const s = (await db.query(
      `INSERT INTO stylists (tenant_id, slug, name, ghl_user_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [t.id, slug, name, ghl],
    )).rows[0].id;
    await db.query('INSERT INTO stylist_services (stylist_id, service_id) VALUES ($1, $2)', [s, v]);
    // Seeded hours say both work from 9 AM, which is exactly the mistake.
    await db.query(
      `INSERT INTO stylist_hours (stylist_id, weekday, starts_at, ends_at) VALUES ($1, 6, '09:00', '15:00')`, [s],
    );
  }
  return t;
}

const cleanup = () => pool().query("DELETE FROM tenants WHERE slug = 'zz-hours'");

test('online, only CENTRO free times are offered, and only for linked stylists', { skip }, async () => {
  await cleanup();
  const tenant = await setup();
  const stub = stubCentro();
  const client = await pool().connect();
  try {
    const { days } = await availableSlots(client, tenant, {
      serviceSlug: 'zz-cut', stylistSlug: null, fromDate: DAY.toISODate(), toDate: DAY.toISODate(), centro: true,
    });
    const starts = days.flatMap((d) => d.slots).map((s) => DateTime.fromISO(s.start).setZone(TZ).toFormat('HH:mm'));
    // A 60-minute cut inside 10:00 to 12:00: 10:00 through 11:00, never 9 AM.
    assert.deepEqual(starts, ['10:00', '10:15', '10:30', '10:45', '11:00']);
    // Kim is not linked to a CENTRO user, so is offered nothing online.
    assert.ok(days.flatMap((d) => d.slots).every((s) => s.stylists.join() === 'zz-tami'));

    // Staff still see the salon's own hours: the desk may book outside CENTRO.
    const staff = await availableSlots(client, tenant, {
      serviceSlug: 'zz-cut', stylistSlug: 'zz-kim', fromDate: DAY.toISODate(), toDate: DAY.toISODate(), minLeadMin: 0,
    });
    assert.equal(DateTime.fromISO(staff.days[0].slots[0].start).setZone(TZ).toFormat('HH:mm'), '09:00');
  } finally {
    client.release();
    stub.restore();
    await cleanup();
  }
});

test('an online booking at a time CENTRO does not offer is refused', { skip }, async () => {
  await cleanup();
  const tenant = await setup();
  const stub = stubCentro();
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(createBooking(client, tenant, {
      serviceSlug: 'zz-cut', stylistSlug: 'zz-tami', start: at(9).toISO(),
      guestName: 'ZZ Guest', guestEmail: 'zz-hours@example.com', channel: 'online',
    }), /not available/);
    await client.query('ROLLBACK');
  } finally {
    client.release();
    stub.restore();
    await cleanup();
    await pool().end();
    globalThis.__synergyPool = undefined;
  }
});
