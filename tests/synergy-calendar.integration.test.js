/**
 * The Synergy Calendar: bookings work from this database alone, and Google,
 * when a stylist has connected it, only ever takes time away.
 *
 *   DATABASE_URL=postgres://… node --test "tests/*.test.js"
 *
 * Runs against the seeded tenant (db/seed.sql) on a scratch database, inside
 * transactions it rolls back, except the Google mirror test, which needs its
 * booking committed and deletes it afterwards. Test rows are named ZZ.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';
import pg from 'pg';

import { availableSlots, combineServices } from '../api/_lib/availability.js';
import { createBooking } from '../api/_lib/booking.js';
import { setGoogleReaderForTests } from '../api/_lib/google-busy.js';
import { mirrorToGoogle, setGooglePushForTests } from '../api/_lib/google-mirror.js';

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

async function tenantOf(c) {
  const { rows } = await c.query("SELECT id, slug, name, timezone FROM tenants WHERE slug = 'synergy'");
  return rows[0];
}

const times = (days) => days.flatMap((d) => d.slots).map((s) => DateTime.fromISO(s.start));
const hasAt = (days, dt) => times(days).some((t) => t.toMillis() === dt.toMillis());

/** A team login linked to a seeded stylist, with Google connected one way or the other. */
async function linkLogin(c, tenant, stylistSlug, { ics = null, refresh = null } = {}) {
  const { rows } = await c.query(
    `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, google_ics, google_refresh_token)
     VALUES ($1, $2, 'x', $3, 'stylist', $4, $5) RETURNING id`,
    [tenant.id, `zz-${stylistSlug}-${Date.now()}@example.com`, `ZZ ${stylistSlug}`, ics, refresh],
  );
  await c.query('UPDATE stylists SET staff_user_id = $1 WHERE tenant_id = $2 AND slug = $3',
    [rows[0].id, tenant.id, stylistSlug]);
  return rows[0].id;
}

/** A stylist added after the salon's four, offering what Micah offers, on her hours. */
async function newStylist(c, tenant) {
  const { rows } = await c.query(
    `INSERT INTO stylists (tenant_id, slug, name) VALUES ($1, 'zz-new', 'ZZ New') RETURNING id`, [tenant.id]);
  await c.query(
    `INSERT INTO stylist_services (stylist_id, service_id)
     SELECT $1, ss.service_id FROM stylist_services ss JOIN stylists s ON s.id = ss.stylist_id
      WHERE s.tenant_id = $2 AND s.slug = 'micah'`, [rows[0].id, tenant.id]);
  await c.query(
    `INSERT INTO stylist_hours (stylist_id, weekday, starts_at, ends_at)
     SELECT $1, h.weekday, h.starts_at, h.ends_at FROM stylist_hours h JOIN stylists s ON s.id = h.stylist_id
      WHERE s.tenant_id = $2 AND s.slug = 'micah'`, [rows[0].id, tenant.id]);
}

test('a new stylist with no Google Calendar is not offered online; the desk still books them', { skip }, async () => {
  const c = await connect();
  try {
    await c.query('BEGIN');
    const tenant = await tenantOf(c);
    const day = tuesday(tenant.timezone);
    const ten = day.set({ hour: 10 });
    await newStylist(c, tenant);
    const online = () => availableSlots(c, tenant, {
      serviceSlug: 'haircuts', stylistSlug: 'zz-new', fromDate: day.toISODate(), toDate: day.toISODate(), google: true,
    });

    // The salon's rule: nobody added to the app is shown to guests until
    // their Google Calendar is connected, however services and hours are set.
    await assert.rejects(online(), (err) => err.status === 404);
    await assert.rejects(createBooking(c, tenant, {
      serviceSlug: 'haircuts', stylistSlug: 'zz-new', start: ten.toISO(),
      guestName: 'ZZ Website', guestEmail: 'zz@example.com', channel: 'online',
    }), (err) => err.status === 404);
    const anyone = await availableSlots(c, tenant, {
      serviceSlug: 'haircuts', fromDate: day.toISODate(), toDate: day.toISODate(), google: true,
    });
    assert.ok(!anyone.stylists.some((s) => s.slug === 'zz-new'), 'not among "first available" either');
    // The desk is not limited by it.
    const desk = await availableSlots(c, tenant, {
      serviceSlug: 'haircuts', stylistSlug: 'zz-new', fromDate: day.toISODate(), toDate: day.toISODate(),
    });
    assert.ok(hasAt(desk.days, ten), 'the desk sees their own hours');

    // Connected, with nothing in Google: offered from the hours stored here.
    await linkLogin(c, tenant, 'zz-new', { ics: 'https://calendar.google.com/calendar/ical/zz/private-x/basic.ics' });
    setGoogleReaderForTests(async () => []);
    assert.ok(hasAt((await online()).days, ten), '10:00 is offered once connected');
  } finally {
    setGoogleReaderForTests(async () => []);
    await c.query('ROLLBACK');
    await c.end();
  }
});

test('the salon\'s four stylists are booked from the Synergy Calendar alone until they connect', { skip }, async () => {
  const c = await connect();
  try {
    await c.query('BEGIN');
    const tenant = await tenantOf(c);
    const day = tuesday(tenant.timezone);
    const ten = day.set({ hour: 10 });
    const online = () => availableSlots(c, tenant, {
      serviceSlug: 'haircuts', stylistSlug: 'micah', fromDate: day.toISODate(), toDate: day.toISODate(), google: true,
    });

    // Offered from the hours stored here, with no Google anywhere.
    assert.ok(hasAt((await online()).days, ten), '10:00 is offered from Micah\'s own hours');

    const web = await createBooking(c, tenant, {
      serviceSlug: 'haircuts', stylistSlug: 'micah', start: ten.toISO(),
      guestName: 'ZZ Website', guestEmail: 'zz@example.com', channel: 'online',
    });
    assert.equal(web.stylist_slug, 'micah');

    // The desk now cannot sell the same hour: one calendar for both.
    await assert.rejects(createBooking(c, tenant, {
      serviceSlug: 'haircuts', stylistSlug: 'micah', start: ten.toISO(),
      guestName: 'ZZ Desk', guestPhone: '8135550100', channel: 'staff', minLeadMin: 0,
    }), (err) => err.status === 409);

    // And the website stops offering it.
    assert.ok(!hasAt((await online()).days, ten), 'the booked hour is gone for guests too');

    // CENTRO still gets its copy of the booking.
    const { rows } = await c.query(
      "SELECT 1 FROM sync_outbox WHERE appointment_id = $1 AND kind = 'appointment.booked'", [web.id]);
    assert.equal(rows.length, 1);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});

test('Google busy time is taken out for guests; the desk can still book over it', { skip }, async () => {
  const c = await connect();
  try {
    await c.query('BEGIN');
    const tenant = await tenantOf(c);
    const day = tuesday(tenant.timezone);
    await linkLogin(c, tenant, 'tami', { ics: 'https://calendar.google.com/calendar/ical/zz/private-x/basic.ics' });
    setGoogleReaderForTests(async () => [{
      allDay: false,
      startsAt: day.set({ hour: 10 }).toISO(),
      endsAt: day.set({ hour: 11 }).toISO(),
    }]);

    const ask = (google) => availableSlots(c, tenant, {
      serviceSlug: 'haircuts', stylistSlug: 'tami', fromDate: day.toISODate(), toDate: day.toISODate(), google,
    });
    const guest = await ask(true);
    assert.ok(!hasAt(guest.days, day.set({ hour: 10 })), 'busy in Google at 10');
    assert.ok(!hasAt(guest.days, day.set({ hour: 9, minute: 30 })), 'a 60 minute cut at 9:30 runs into it');
    assert.ok(hasAt(guest.days, day.set({ hour: 9 })), '9:00 finishes as Google\'s event starts');
    assert.ok(hasAt(guest.days, day.set({ hour: 11 })), 'free again at 11');
    const desk = await ask(false);
    assert.ok(hasAt(desk.days, day.set({ hour: 10 })), 'the desk sees the Synergy Calendar as it is');

    await assert.rejects(createBooking(c, tenant, {
      serviceSlug: 'haircuts', stylistSlug: 'tami', start: day.set({ hour: 10 }).toISO(),
      guestName: 'ZZ Website', guestPhone: '8135550100', guestEmail: 'zz@example.com', channel: 'online',
    }), (err) => err.status === 409);
    const byDesk = await createBooking(c, tenant, {
      serviceSlug: 'haircuts', stylistSlug: 'tami', start: day.set({ hour: 10 }).toISO(),
      guestName: 'ZZ Desk', guestPhone: '8135550100', channel: 'staff', minLeadMin: 0,
    });
    assert.ok(byDesk.ref);

    // A calendar that cannot be read hides that stylist from guests only.
    setGoogleReaderForTests(async () => { throw new Error('Google did not answer'); });
    assert.equal(times((await ask(true)).days).length, 0, 'nothing offered online while unreadable');
    assert.ok(times((await ask(false)).days).length > 0, 'the desk still sees the day');
  } finally {
    setGoogleReaderForTests(async () => []);
    await c.query('ROLLBACK');
    await c.end();
  }
});

test('several services are one appointment, long enough for all of them', { skip }, async () => {
  const c = await connect();
  try {
    await c.query('BEGIN');
    const tenant = await tenantOf(c);
    const day = tuesday(tenant.timezone);

    // Cut (60 + 10 clean-down) then blowout (45 + 10): 115 minutes of the
    // guest's time, the last clean-down after, no price while either is unpriced.
    const ask = (extra, stylist = 'dina', length = null) => availableSlots(c, tenant, {
      serviceSlug: 'haircuts', extraServiceSlugs: extra, stylistSlug: stylist, length,
      fromDate: day.toISODate(), toDate: day.toISODate(),
    });
    const both = await ask(['blowouts']);
    assert.equal(both.visit.durationMin, 115);
    assert.equal(both.visit.bufferMin, 10);
    assert.equal(both.visit.priceCents, null);
    // Tuesday closes at 3: the last start that finishes by then is 1:00.
    assert.ok(hasAt(both.days, day.set({ hour: 13 })));
    assert.ok(!hasAt(both.days, day.set({ hour: 13, minute: 15 })));
    assert.ok(hasAt((await ask([])).days, day.set({ hour: 14 })), 'a cut alone still fits at 2');

    // Booked online, so Dina needs a Google Calendar connected (empty here).
    await linkLogin(c, tenant, 'dina', { ics: 'https://calendar.google.com/calendar/ical/zz/private-x/basic.ics' });
    setGoogleReaderForTests(async () => []);
    const appt = await createBooking(c, tenant, {
      serviceSlug: 'haircuts', extraServiceSlugs: ['blowouts'], stylistSlug: 'dina',
      start: day.set({ hour: 13 }).toISO(), guestName: 'ZZ Two services', guestPhone: '8135550100', guestEmail: 'zz@example.com', channel: 'online',
    });
    assert.equal(appt.duration_min, 115);

    // Moving it keeps its own length: 1:15 is refused, as it would run late.
    const move = await ask([], 'dina', { durationMin: 115, bufferMin: 10 });
    assert.ok(!hasAt(move.days, day.set({ hour: 13, minute: 15 })));

    // A stylist who does not offer every service is not offered at all.
    await c.query(
      `DELETE FROM stylist_services ss USING stylists s, services v
        WHERE ss.stylist_id = s.id AND ss.service_id = v.id AND s.slug = 'kim' AND v.slug = 'blowouts'`);
    await assert.rejects(ask(['blowouts'], 'kim'), (err) => err.status === 404);
    const anyone = await ask(['blowouts'], null);
    assert.ok(!anyone.stylists.some((s) => s.slug === 'kim'));
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});

test('combineServices prices a visit only when every part has a price', () => {
  const a = { name: 'A', duration_min: 30, buffer_min: 10, price_cents: 4000 };
  const b = { name: 'B', duration_min: 60, buffer_min: 15, price_cents: 5000 };
  assert.deepEqual(combineServices(a, [b]), { durationMin: 100, bufferMin: 15, priceCents: 9000, names: ['A', 'B'] });
  assert.equal(combineServices(a, [{ ...b, price_cents: null }]).priceCents, null);
  assert.equal(combineServices(a).durationMin, 30);
});

test('a booking and its cancellation reach the stylist\'s Google Calendar', { skip }, async () => {
  const c = await connect();
  const pushed = [];
  let userId = null;
  let apptId = null;
  try {
    const tenant = await tenantOf(c);
    const day = tuesday(tenant.timezone);
    userId = await linkLogin(c, tenant, 'dina', { refresh: 'zz-token' });
    setGooglePushForTests(async (uid, appt) => {
      pushed.push({ uid, ref: appt.ref, status: appt.status });
      await c.query(
        `INSERT INTO google_events (appointment_id, staff_user_id, event_id) VALUES ($1, $2, 'zz-event')
         ON CONFLICT (appointment_id, staff_user_id) DO UPDATE SET updated_at = now()`,
        [appt.id, uid]);
      return 'zz-event';
    });

    await c.query('BEGIN');
    const appt = await createBooking(c, tenant, {
      serviceSlug: 'haircuts', stylistSlug: 'dina', start: day.set({ hour: 11 }).toISO(),
      guestName: 'ZZ Mirror', guestPhone: '8135550100', guestEmail: 'zz@example.com', channel: 'online',
    });
    await c.query('COMMIT');
    apptId = appt.id;

    await mirrorToGoogle({ tenantId: tenant.id });
    assert.deepEqual(pushed.map((p) => [p.uid, p.ref, p.status]), [[userId, appt.ref, 'booked']]);
    await mirrorToGoogle({ tenantId: tenant.id });
    assert.equal(pushed.length, 1, 'an up-to-date copy is not pushed again');

    await c.query(
      `UPDATE appointments SET status = 'cancelled', updated_at = now() + interval '1 second' WHERE id = $1`, [appt.id]);
    await mirrorToGoogle({ tenantId: tenant.id });
    assert.equal(pushed.at(-1).status, 'cancelled', 'the cancellation follows');
  } finally {
    setGooglePushForTests(null);
    // A failure inside the transaction leaves it aborted, and every cleanup
    // statement after it would be refused: end it first.
    await c.query('ROLLBACK').catch(() => {});
    if (apptId) await c.query('DELETE FROM appointments WHERE id = $1', [apptId]);
    await c.query("UPDATE stylists SET staff_user_id = NULL WHERE slug = 'dina'");
    if (userId) await c.query('DELETE FROM staff_users WHERE id = $1', [userId]);
    await c.end();
  }
});

test('every booking is as long as its own service, from the website and the desk', { skip }, async () => {
  // A booking calendar carries a length of its own (30 minutes unless set),
  // shown on its chip, which read as the length of every appointment. It is
  // never used: the service decides, whichever way the booking comes in.
  const c = await connect();
  try {
    await c.query('BEGIN');
    const tenant = await tenantOf(c);
    const day = tuesday(tenant.timezone);
    await linkLogin(c, tenant, 'dina', { ics: 'https://calendar.google.com/calendar/ical/zz/private-y/basic.ics' });
    setGoogleReaderForTests(async () => []);
    const { rows: svc } = await c.query(
      `SELECT v.slug, v.duration_min FROM services v
        WHERE v.tenant_id = $1 AND v.slug = ANY($2::text[])`,
      [tenant.id, ['bang-trim', 'gloss-or-toner', 'balayage']],
    );
    assert.equal(svc.length, 3);
    for (const [i, s] of svc.entries()) {
      for (const channel of ['online', 'staff']) {
        const { days } = await availableSlots(c, tenant, {
          serviceSlug: s.slug, stylistSlug: channel === 'online' ? 'dina' : null,
          google: channel === 'online', fromDate: day.toISODate(), toDate: day.plus({ days: 6 }).toISODate(),
        });
        const slot = days.flatMap((d) => d.slots)[0];
        assert.ok(slot, `a time for ${s.slug}`);
        const appt = await createBooking(c, tenant, {
          serviceSlug: s.slug, stylistSlug: channel === 'online' ? 'dina' : slot.stylists?.[0] || null,
          start: slot.start, guestName: `ZZ Length ${i} ${channel}`, guestPhone: '8135550101',
          guestEmail: 'zz@example.com', channel,
        });
        assert.equal(appt.duration_min, s.duration_min, `${s.slug} booked ${channel}`);
      }
    }
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});
