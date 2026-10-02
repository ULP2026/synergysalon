/**
 * The hours a salon types are the hours a guest is offered.
 *
 *   DATABASE_URL=postgres://… node --test "tests/*.test.js"
 *
 * This replaces the CENTRO availability test. Availability used to be asked of
 * CENTRO, which meant a stylist with no CENTRO user linked could be offered
 * nothing at all -- the state every stylist was in, and the reason online
 * booking was switched off. Hours now come from stylist_hours, which the team
 * dialog writes, so a salon that has never heard of CENTRO can take bookings.
 *
 * Skips without DATABASE_URL. Runs in a throwaway ZZ tenant and removes it.
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
const hhmm = (iso) => DateTime.fromISO(iso).setZone(TZ).toFormat('HH:mm');

async function setup() {
  const db = pool();
  const t = (await db.query(
    `INSERT INTO tenants (slug, name, timezone)
     VALUES ('zz-hours', 'ZZ Hours', $1) RETURNING id, slug, timezone`, [TZ],
  )).rows[0];
  const v = (await db.query(
    `INSERT INTO services (tenant_id, slug, name, category, duration_min, buffer_min)
     VALUES ($1, 'zz-cut', 'ZZ Cut', 'cuts', 60, 15) RETURNING id`, [t.id],
  )).rows[0].id;

  const ids = {};
  // Neither is linked to anything outside this database. That is the point.
  for (const [slug, name] of [['zz-tami', 'ZZ Tami'], ['zz-kim', 'ZZ Kim']]) {
    const s = (await db.query(
      'INSERT INTO stylists (tenant_id, slug, name) VALUES ($1, $2, $3) RETURNING id',
      [t.id, slug, name],
    )).rows[0].id;
    ids[slug] = s;
    await db.query('INSERT INTO stylist_services (stylist_id, service_id) VALUES ($1, $2)', [s, v]);
    await db.query(
      "INSERT INTO stylist_hours (stylist_id, weekday, starts_at, ends_at) VALUES ($1, 6, '09:00', '15:00')",
      [s],
    );
  }
  return { tenant: t, ids };
}

const cleanup = () => pool().query("DELETE FROM tenants WHERE slug = 'zz-hours'");

test('a stylist is offered their own hours, with nothing to link', { skip }, async () => {
  await cleanup();
  const { tenant } = await setup();
  const client = await pool().connect();
  try {
    const { days } = await availableSlots(client, tenant, {
      serviceSlug: 'zz-cut', stylistSlug: null, fromDate: DAY.toISODate(), toDate: DAY.toISODate(),
    });
    const starts = days.flatMap((d) => d.slots).map((s) => hhmm(s.start));
    // 09:00 to 15:00, a 60-minute cut, every quarter hour: the last start that
    // still finishes by closing is 14:00.
    assert.equal(starts[0], '09:00');
    assert.equal(starts.at(-1), '14:00');
    assert.equal(starts.length, 21);

    // Both of them, every slot. Under CENTRO this was the failure: a stylist
    // nobody had linked was silently offered nothing.
    const everySlot = days.flatMap((d) => d.slots);
    assert.ok(everySlot.every((s) => s.stylists.length === 2),
      'both stylists should be offered, neither linked to anything');
  } finally {
    client.release();
    await cleanup();
  }
});

test('a booking outside those hours is refused', { skip }, async () => {
  await cleanup();
  const { tenant } = await setup();
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    // An hour before they open.
    await assert.rejects(createBooking(client, tenant, {
      serviceSlug: 'zz-cut', stylistSlug: 'zz-tami', start: at(8).toISO(),
      guestName: 'ZZ Guest', guestEmail: 'zz-hours@example.com', channel: 'online',
    }), /not available/);

    // And one that would run past closing: 14:15 plus an hour is 15:15.
    await assert.rejects(createBooking(client, tenant, {
      serviceSlug: 'zz-cut', stylistSlug: 'zz-tami', start: at(14, 15).toISO(),
      guestName: 'ZZ Guest', guestEmail: 'zz-hours@example.com', channel: 'online',
    }), /not available/);

    // Inside them, it goes through.
    const made = await createBooking(client, tenant, {
      serviceSlug: 'zz-cut', stylistSlug: 'zz-tami', start: at(10).toISO(),
      guestName: 'ZZ Guest', guestEmail: 'zz-hours@example.com', channel: 'online',
    });
    assert.ok(made?.id, 'a time inside the hours should book');
    await client.query('ROLLBACK');
  } finally {
    client.release();
    await cleanup();
  }
});

test('time off takes the chair out of the day', { skip }, async () => {
  await cleanup();
  const { tenant, ids } = await setup();
  const client = await pool().connect();
  try {
    await client.query(
      `INSERT INTO time_off (tenant_id, stylist_id, during, reason)
       VALUES ($1, $2, tstzrange($3::timestamptz, $4::timestamptz), 'ZZ training')`,
      [tenant.id, ids['zz-tami'], at(10).toISO(), at(12).toISO()],
    );
    const { days } = await availableSlots(client, tenant, {
      serviceSlug: 'zz-cut', stylistSlug: 'zz-tami', fromDate: DAY.toISODate(), toDate: DAY.toISODate(),
    });
    const starts = days.flatMap((d) => d.slots).map((s) => hhmm(s.start));
    // The cut plus its clean-down may not touch 10:00 to 12:00, so nothing may
    // start from 08:45 onward until the block has passed.
    assert.ok(!starts.some((h) => h >= '09:00' && h < '12:00'),
      `nothing should be offered across the time off, got ${starts.join(' ')}`);
    assert.ok(starts.includes('12:00'), 'the chair is free again afterwards');
  } finally {
    client.release();
    await cleanup();
    await pool().end();
    globalThis.__synergyPool = undefined;
  }
});
