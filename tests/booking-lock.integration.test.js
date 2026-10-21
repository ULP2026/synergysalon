/**
 * Two writes to the same stylist's diary at the same moment: the second waits
 * for the first, then sees it.
 *
 *   TEST_DATABASE_URL=postgres://localhost/… npm test
 *
 * The race this closes: the free-time check and the write are two steps, and
 * neither request sees the other's uncommitted booking. The exclusion
 * constraint compares guest time only (migration 027), so a 10:00 haircut and
 * an 11:00 one -- 60 minutes each, 15 to turn the station round -- both used
 * to go in, with no time left to reset between them. lockDiaries and
 * lockStylist (booking.js) make the second wait for the first to commit,
 * after which its check refuses 11:00 like any other path would. A new
 * booking, the front desk's reopen and the guest's reschedule all take it.
 *
 * THESE TESTS COMMIT: the first booking has to commit for the second to see
 * it, which is the thing being tested. So they run only against a database on
 * this machine, never the live one whatever ALLOW_PRODUCTION_TESTS says.
 *
 * They run in a ZZ salon of their own, removed afterwards. The lock is per
 * stylist, not per day, so a seeded stylist is no good here: the other test
 * files run alongside and book Dina or Micah inside open transactions, which
 * holds their diaries for as long as those tests take. Two stylists, a
 * 60-minute cut with 15 to turn round, Saturdays 09:00 to 17:00, and a Google
 * Calendar connected with nothing in it for the one a guest moves with,
 * because a guest is only offered a stylist who has one.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';
import pg from 'pg';

import guestAppointment from '../api/appointment.js';
import { createSession } from '../api/_lib/auth.js';
import { SLOT_TAKEN_MESSAGE, createBooking } from '../api/_lib/booking.js';
import { pool, transaction } from '../api/_lib/db.js';
import { setGoogleReaderForTests } from '../api/_lib/google-busy.js';
import staffAppointment from '../api/staff/_routes/appointment.js';

const url = process.env.DATABASE_URL;
const local = Boolean(url) && /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const skip = local ? false : 'commits, so it runs only against a database on this machine';

const TZ = 'America/New_York';

const connect = async () => {
  const c = new pg.Client({ connectionString: url, ssl: false });
  await c.connect();
  return c;
};

const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function lockSalon() {
  const db = pool();
  await db.query("DELETE FROM tenants WHERE slug = 'zz-lock'");
  const tenant = (await db.query(
    "INSERT INTO tenants (slug, name, timezone) VALUES ('zz-lock', 'ZZ Lock', $1) RETURNING *", [TZ],
  )).rows[0];
  const service = (await db.query(
    `INSERT INTO services (tenant_id, slug, name, category, duration_min, buffer_min)
     VALUES ($1, 'zz-cut', 'ZZ Cut', 'cuts', 60, 15) RETURNING id`, [tenant.id],
  )).rows[0].id;
  const owner = (await db.query(
    `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, google_ics)
     VALUES ($1, 'zz-lock-owner@example.com', 'x', 'ZZ Lock Owner', 'owner',
             'https://calendar.google.com/calendar/ical/zz/private-x/basic.ics') RETURNING *`,
    [tenant.id],
  )).rows[0];
  for (const [slug, name, login] of [['zz-lena', 'ZZ Lena', owner.id], ['zz-mara', 'ZZ Mara', null]]) {
    const stylist = (await db.query(
      'INSERT INTO stylists (tenant_id, slug, name, staff_user_id) VALUES ($1, $2, $3, $4) RETURNING id',
      [tenant.id, slug, name, login],
    )).rows[0].id;
    await db.query('INSERT INTO stylist_services (stylist_id, service_id) VALUES ($1, $2)', [stylist, service]);
    await db.query(
      "INSERT INTO stylist_hours (stylist_id, weekday, starts_at, ends_at) VALUES ($1, 6, '09:00', '17:00')",
      [stylist],
    );
  }
  setGoogleReaderForTests(async () => []);

  const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } };
  await createSession(res, owner);
  const cookie = String(res.headers['set-cookie']).split(';')[0];

  // A Saturday four weeks out: past the guest's lead time, inside the horizon.
  let day = DateTime.now().setZone(TZ).plus({ weeks: 4 }).startOf('day');
  while (day.weekday !== 6) day = day.plus({ days: 1 });

  const book = (c, stylistSlug, hour, minute = 0) => createBooking(c, tenant, {
    serviceSlug: 'zz-cut', stylistSlug, start: day.set({ hour, minute }).toISO(),
    // A guest of their own each: every booking makes or finds its client by
    // email, and two open transactions creating the same client wait on each
    // other, which is not the wait being tested.
    guestName: `ZZ Lock ${stylistSlug} ${hour}:${minute}`,
    guestEmail: `zz-lock-${stylistSlug}-${hour}${minute}@example.com`,
    channel: 'staff', minLeadMin: 0,
  });
  return { tenant, cookie, day, book };
}

const dropLockSalon = () => pool().query("DELETE FROM tenants WHERE slug = 'zz-lock'");

/** Enough of a Node request and response for handler() and json(). */
function drive(route, { method, url: path = '/', headers = {}, body }) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }); },
    };
    route({ method, url: path, headers, body }, res);
  });
}

test('a second booking for the same stylist waits, then is refused for squeezing the turnaround', { skip }, async () => {
  const { book } = await lockSalon();
  const a = await connect();
  const b = await connect();
  try {
    // A books 10:00 and holds its transaction open.
    await a.query('BEGIN');
    await book(a, 'zz-lena', 10);

    // B asks for 11:00 at the same moment. Without the lock it would sail
    // through now: A's booking is invisible to it until A commits.
    await b.query('BEGIN');
    const second = book(b, 'zz-lena', 11);
    second.catch(() => {});   // judged below, once A has committed
    const state = await Promise.race([
      second.then(() => 'booked', () => 'refused'),
      pause(800).then(() => 'waiting'),
    ]);
    assert.equal(state, 'waiting', 'the second booking waits for the first');

    // A commits; B's free-time check now sees 10:00 and its turnaround.
    await a.query('COMMIT');
    await assert.rejects(second, (err) => err.status === 409 && err.message === SLOT_TAKEN_MESSAGE,
      '11:00 would leave no turnaround');
    await b.query('ROLLBACK');

    // A different stylist is never held up by Lena's diary. Asked of
    // Postgres rather than a stopwatch: while A is open, another test file
    // running alongside can queue a schema change (ensureSchema) on the
    // appointments table, and Postgres queues later writers behind it, so B
    // can be slow for a reason that has nothing to do with diaries. What
    // must never happen is B waiting on an advisory lock.
    await a.query('BEGIN');
    await b.query('BEGIN');
    const { rows: [{ pid }] } = await b.query('SELECT pg_backend_pid() AS pid');
    await book(a, 'zz-lena', 13);
    const other = book(b, 'zz-mara', 13).then(() => 'booked', (err) => `refused: ${err.message}`);
    let otherState = 'waiting';
    for (let i = 0; i < 100 && otherState === 'waiting'; i++) {
      otherState = await Promise.race([other, pause(100).then(() => 'waiting')]);
      if (otherState !== 'waiting') break;
      // Still going: once Postgres says what B is waiting on, judge it.
      const { rows: waits } = await pool().query(
        'SELECT locktype FROM pg_locks WHERE pid = $1 AND NOT granted', [pid]);
      if (!waits.length) continue;
      assert.ok(!waits.some((w) => w.locktype === 'advisory'),
        "another stylist's booking waits for Lena's diary");
      await a.query('ROLLBACK');   // the unrelated wait, released
      otherState = await other;
    }
    assert.equal(otherState, 'booked', 'another stylist books');
    await a.query('ROLLBACK');
    await b.query('ROLLBACK');
  } finally {
    await a.query('ROLLBACK').catch(() => {});
    await b.query('ROLLBACK').catch(() => {});
    await a.end();
    await b.end();
    await dropLockSalon();
  }
});

test('reopening a cancelled appointment waits for a booking in progress, then is refused for the turnaround', { skip }, async () => {
  const { cookie, book } = await lockSalon();
  const b = await connect();
  try {
    const reopen = (ref) => drive(staffAppointment, {
      method: 'POST', headers: { cookie }, body: { ref, action: 'reopen' },
    });

    // 10:00, then cancelled: its hour is free again.
    const first = await transaction((c) => book(c, 'zz-lena', 10));
    await pool().query("UPDATE appointments SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [first.id]);

    // Somebody books 11:00 and holds the transaction open. 10:00 back in
    // place would leave no turnaround before it, and the exclusion
    // constraint, comparing guest time only, would not notice.
    await b.query('BEGIN');
    const taken = await book(b, 'zz-lena', 11);

    const answer = reopen(first.ref);
    const state = await Promise.race([answer.then(() => 'answered'), pause(800).then(() => 'waiting')]);
    assert.equal(state, 'waiting', 'the reopen waits for the booking in progress');

    await b.query('COMMIT');
    const refused = await answer;
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, SLOT_TAKEN_MESSAGE);

    // With 11:00 gone again the same reopen goes through: the refusal above
    // was the turnaround, not something else about the appointment.
    await pool().query('DELETE FROM appointments WHERE id = $1', [taken.id]);
    const back = await reopen(first.ref);
    assert.equal(back.status, 200);
    const { rows: [now] } = await pool().query('SELECT status FROM appointments WHERE id = $1', [first.id]);
    assert.equal(now.status, 'booked');
  } finally {
    await b.query('ROLLBACK').catch(() => {});
    await b.end();
    await dropLockSalon();
  }
});

test('a guest rescheduling into a time being booked waits, then is refused with the same message', { skip }, async () => {
  const { day, book } = await lockSalon();
  const b = await connect();
  try {
    const move = (appt, hour, minute = 0) => drive(guestAppointment, {
      method: 'PATCH',
      url: `/api/appointment?salon=zz-lock&ref=${appt.ref}&t=${appt.manage_token}`,
      body: { start: day.set({ hour, minute }).toISO() },
    });

    const mine = await transaction((c) => book(c, 'zz-lena', 14));

    // 11:00 is being booked by somebody else, not yet committed.
    await b.query('BEGIN');
    await book(b, 'zz-lena', 11);

    // Moving to 12:00 would sit in that booking's turnaround.
    const answer = move(mine, 12);
    const state = await Promise.race([answer.then(() => 'answered'), pause(800).then(() => 'waiting')]);
    assert.equal(state, 'waiting', 'the reschedule waits for the booking in progress');

    await b.query('COMMIT');
    const refused = await answer;
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, SLOT_TAKEN_MESSAGE);

    // 12:15, after the turnaround, is still theirs to take.
    const moved = await move(mine, 12, 15);
    assert.equal(moved.status, 200);
  } finally {
    await b.query('ROLLBACK').catch(() => {});
    await b.end();
    await dropLockSalon();
  }
});
