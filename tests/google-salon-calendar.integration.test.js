/**
 * Bookings copied to a stylist's Google account go into the salon's own
 * calendar there, made by the app, not into their main calendar.
 *
 *   DATABASE_URL=postgres://… node --test "tests/*.test.js"
 *
 * Google is a fake here (global fetch is swapped for the test): what is
 * checked is what the app asks Google to do. Runs against the seeded tenant,
 * removes its ZZ rows afterwards.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createBooking } from '../api/_lib/booking.js';
import { pool, transaction } from '../api/_lib/db.js';
import { anyBookable } from './bookable.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
process.env.TOKEN_KEY ||= 'zz-test-key-for-google-tokens';
process.env.GOOGLE_CLIENT_ID ||= 'zz-client';
process.env.GOOGLE_CLIENT_SECRET ||= 'zz-secret';

const { encryptSecret } = await import('../api/_lib/secrets.js');
const { busyBetween, pushEvent, salonCalendarFor } = await import('../api/_lib/google.js');

/** A fake Google Calendar API that records every request. */
function fakeGoogle() {
  const calendars = new Map([['primary', new Map()]]);
  const calls = [];
  let n = 0;
  const reply = (status, body) => new Response(body == null ? '' : JSON.stringify(body), { status });
  globalThis.fetch = async (u, init = {}) => {
    const { pathname, searchParams } = new URL(u);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: decodeURIComponent(pathname.replace('/calendar/v3', '')) });
    const parts = pathname.replace('/calendar/v3/calendars', '').split('/').filter(Boolean).map(decodeURIComponent);
    if (method === 'POST' && parts.length === 0) {
      const id = `zz-cal-${++n}@group.calendar.google.com`;
      calendars.set(id, new Map());
      return reply(200, { id, summary: body.summary });
    }
    const cal = calendars.get(parts[0]);
    if (!cal) return reply(404, { error: 'notFound' });
    if (parts.length === 1) return reply(200, { id: parts[0] });
    if (method === 'POST') { const id = `zz-ev-${++n}`; cal.set(id, body); return reply(200, { id }); }
    if (method === 'PATCH') {
      if (!cal.has(parts[2])) return reply(404, {});
      cal.set(parts[2], { ...cal.get(parts[2]), ...body });
      return reply(200, { id: parts[2] });
    }
    if (method === 'GET' && parts[1] === 'events') {
      void searchParams;
      return reply(200, { items: [...cal.entries()].map(([id, e]) => ({ id, status: 'confirmed', ...e })) });
    }
    return reply(400, {});
  };
  return { calendars, calls };
}

async function setup(db) {
  const t = (await db.query("SELECT id, name, timezone FROM tenants WHERE slug = 'synergy'")).rows[0];
  const u = (await db.query(
    `INSERT INTO staff_users (tenant_id, email, password_hash, name, role,
                              google_refresh_token, google_access_token, google_expires_at)
     VALUES ($1, 'zz-salon-cal@example.com', 'x', 'ZZ Salon Cal', 'stylist', $2, $3, now() + interval '1 hour')
     RETURNING id`,
    [t.id, encryptSecret('zz-refresh'), encryptSecret('zz-access')],
  )).rows[0].id;
  // Through the app's own booking path, a week out at 10.
  //
  // Whoever is already bookable, rather than a named stylist. This test
  // commits -- the salon calendar is created on a real booking -- so it
  // must not switch anybody on to make itself work: a stylist left active
  // outlives the run and is offered to guests. It used to name Kim, who is
  // set up in db/seed.sql and switched off in the live database, so against
  // production it only ever failed.
  const { DateTime } = await import('luxon');
  let day = DateTime.now().setZone(t.timezone).plus({ days: 7 }).startOf('day');
  while (day.weekday !== 2) day = day.plus({ days: 1 });
  const stylistSlug = await anyBookable(db, t.id);
  const a = await transaction((c) => createBooking(c, { ...t, slug: 'synergy' }, {
    serviceSlug: 'haircuts', stylistSlug, start: day.set({ hour: 10 }).toISO(),
    guestName: 'ZZ Guest', guestPhone: '8135550100', channel: 'staff', minLeadMin: 0,
  }));
  return { tenant: t, userId: u, appt: { ...a, service_name: 'Haircut', salon_name: t.name } };
}

async function cleanup(db) {
  // The client the booking made as well (createBooking has made one for
  // every booking since 3bc53b6): this test commits, so leaving it would
  // leave a ZZ client behind for good. Only ZZ ones, and only those its
  // bookings point at.
  const { rows } = await db.query(
    `DELETE FROM appointments WHERE guest_name LIKE 'ZZ Guest%'
        AND tenant_id = (SELECT id FROM tenants WHERE slug = 'synergy')
     RETURNING contact_id`);
  const contacts = rows.map((r) => r.contact_id).filter(Boolean);
  if (contacts.length) {
    await db.query("DELETE FROM contacts WHERE id = ANY($1::uuid[]) AND name LIKE 'ZZ%'", [contacts]);
  }
  await db.query("DELETE FROM staff_users WHERE email = 'zz-salon-cal@example.com'");
}

test('a booking goes into the salon calendar, made once and reused', { skip }, async () => {
  const db = pool();
  const realFetch = globalThis.fetch;
  await cleanup(db);
  try {
    const { tenant, userId, appt } = await setup(db);
    const g = fakeGoogle();

    const eventId = await pushEvent(userId, appt, tenant.timezone);
    const made = g.calls.filter((c) => c.method === 'POST' && c.path === '/calendars');
    assert.equal(made.length, 1, 'one salon calendar is created');
    const calId = (await db.query('SELECT google_calendar_id FROM staff_users WHERE id = $1', [userId])).rows[0].google_calendar_id;
    assert.match(calId, /^zz-cal-/);
    assert.ok(g.calendars.get(calId).has(eventId), 'the event is in the salon calendar');
    assert.equal(g.calendars.get('primary').size, 0, 'nothing in their main calendar');
    const row = (await db.query('SELECT calendar_id FROM google_events WHERE appointment_id = $1', [appt.id])).rows[0];
    assert.equal(row.calendar_id, calId);

    // Moved: edited where it is, no second calendar.
    await pushEvent(userId, { ...appt, guest_name: 'ZZ Guest Moved' }, tenant.timezone);
    assert.equal(g.calls.filter((c) => c.method === 'POST' && c.path === '/calendars').length, 1);
    assert.equal(g.calendars.get(calId).get(eventId).summary, 'ZZ Guest Moved · Haircut');

    // The stylist deleted the calendar in Google: made again, booking not lost.
    g.calendars.delete(calId);
    await db.query('DELETE FROM google_events WHERE appointment_id = $1', [appt.id]);
    await pushEvent(userId, appt, tenant.timezone);
    const again = (await db.query('SELECT google_calendar_id FROM staff_users WHERE id = $1', [userId])).rows[0].google_calendar_id;
    assert.notEqual(again, calId);
    assert.equal(g.calendars.get(again).size, 1);

    // Reconnecting the same account finds the calendar it has.
    assert.equal(await salonCalendarFor(userId, 'zz-access', tenant, { verify: true }), again);
  } finally {
    globalThis.fetch = realFetch;
    await cleanup(db);
  }
});

test('a connection without the permission keeps using the main calendar', { skip }, async () => {
  const db = pool();
  const realFetch = globalThis.fetch;
  await cleanup(db);
  try {
    const { tenant, userId, appt } = await setup(db);
    await db.query("UPDATE staff_users SET google_calendar_id = 'primary' WHERE id = $1", [userId]);
    const g = fakeGoogle();
    const eventId = await pushEvent(userId, appt, tenant.timezone);
    assert.equal(g.calls.filter((c) => c.path === '/calendars').length, 0, 'no calendar is attempted');
    assert.ok(g.calendars.get('primary').has(eventId));

    // That copy is the booking itself: not read back as Google busy time.
    g.calendars.get('primary').set('zz-dentist', {
      start: { dateTime: new Date(Date.now() + 86_400_000).toISOString() },
      end: { dateTime: new Date(Date.now() + 90_000_000).toISOString() },
    });
    const busy = await busyBetween(userId, new Date().toISOString(), new Date(Date.now() + 7 * 86_400_000).toISOString());
    assert.equal(busy.length, 1, 'only their own event counts as busy');
  } finally {
    globalThis.fetch = realFetch;
    await cleanup(db);
  }
});
