/**
 * Bookings copied to a stylist's Google account go into their main
 * calendar (since 2026-11-06: one calendar in Google, not the account's own
 * plus one the app made). Someone still on a calendar the app made is
 * merged: that calendar is removed and the copies are made again in the
 * main one, never read back as busy time.
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
const { busyBetween, mergeIntoMain, pushEvent, salonCalendarFor } = await import('../api/_lib/google.js');

/** A fake Google Calendar API that records every request. */
function fakeGoogle() {
  const calendars = new Map([['primary', new Map()]]);
  const calls = [];
  let n = 0;
  // 204 has no body at all, as Google sends it.
  const reply = (status, body) => new Response(status === 204 ? null : (body == null ? '' : JSON.stringify(body)), { status });
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
    if (parts.length === 1 && method === 'DELETE') { calendars.delete(parts[0]); return reply(204, null); }
    if (parts.length === 1) return reply(200, { id: parts[0] });
    if (method === 'DELETE') { cal.delete(parts[2]); return reply(204, null); }
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
    serviceSlug: 'womens-cut', stylistSlug, start: day.set({ hour: 10 }).toISO(),
    guestName: 'ZZ Guest', guestPhone: '8135550100', channel: 'staff', minLeadMin: 0,
  }));
  return { tenant: t, userId: u, appt: { ...a, service_name: 'Haircut', salon_name: t.name } };
}

async function cleanup(db) {
  await db.query("DELETE FROM appointments WHERE guest_name LIKE 'ZZ Guest%' AND tenant_id = (SELECT id FROM tenants WHERE slug = 'synergy')");
  await db.query("DELETE FROM staff_users WHERE email = 'zz-salon-cal@example.com'");
}

test('a booking goes into the main calendar, and no second calendar is made', { skip }, async () => {
  const db = pool();
  const realFetch = globalThis.fetch;
  await cleanup(db);
  try {
    const { tenant, userId, appt } = await setup(db);
    const g = fakeGoogle();

    const eventId = await pushEvent(userId, appt, tenant.timezone);
    assert.equal(g.calls.filter((c) => c.method === 'POST' && c.path === '/calendars').length, 0, 'no calendar is made');
    assert.ok(g.calendars.get('primary').has(eventId), 'the event is in their main calendar');
    const calId = (await db.query('SELECT google_calendar_id FROM staff_users WHERE id = $1', [userId])).rows[0].google_calendar_id;
    assert.equal(calId, 'primary');

    // Moved: edited where it is.
    await pushEvent(userId, { ...appt, guest_name: 'ZZ Guest Moved' }, tenant.timezone);
    assert.equal(g.calendars.get('primary').get(eventId).summary, 'ZZ Guest Moved · Haircut');
    assert.equal(g.calendars.get('primary').size, 1);
    assert.equal(await salonCalendarFor(userId, 'zz-access', tenant, { verify: true }), 'primary');
  } finally {
    globalThis.fetch = realFetch;
    await cleanup(db);
  }
});

test('someone on the calendar the app used to make is merged into their main one', { skip }, async () => {
  const db = pool();
  const realFetch = globalThis.fetch;
  await cleanup(db);
  try {
    const { tenant, userId, appt } = await setup(db);
    const g = fakeGoogle();
    // As before 2026-11-06: a calendar the app made, holding the copy.
    g.calendars.set('zz-old-cal', new Map());
    await db.query("UPDATE staff_users SET google_calendar_id = 'zz-old-cal' WHERE id = $1", [userId]);
    const oldEvent = await pushEvent(userId, appt, tenant.timezone);
    assert.ok(g.calendars.get('zz-old-cal').has(oldEvent), 'until merged, copies stay together where they are');

    assert.equal(await mergeIntoMain(userId), 1);
    assert.ok(g.calls.some((c) => c.method === 'DELETE' && c.path === '/calendars/zz-old-cal'), 'removed in one call');
    assert.equal(g.calendars.has('zz-old-cal'), false, 'the calendar the app made is removed');
    assert.equal((await db.query('SELECT count(*)::int n FROM google_events WHERE appointment_id = $1', [appt.id])).rows[0].n, 0);
    assert.equal((await db.query('SELECT google_calendar_id FROM staff_users WHERE id = $1', [userId])).rows[0].google_calendar_id, 'primary');
    assert.equal(await mergeIntoMain(userId), null, 'nothing to merge twice');

    // The mirror puts the copy back, in the main calendar.
    const again = await pushEvent(userId, appt, tenant.timezone);
    assert.ok(g.calendars.get('primary').has(again));
    const busy = await busyBetween(userId, new Date().toISOString(), new Date(Date.now() + 14 * 86_400_000).toISOString());
    assert.equal(busy.length, 0, 'the copy is not read back as busy time');
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
