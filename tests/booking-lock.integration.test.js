/**
 * Two bookings for the same stylist at the same moment: the second waits for
 * the first, then sees it.
 *
 *   TEST_DATABASE_URL=postgres://localhost/… npm test
 *
 * The race this closes: the free-time check and the insert are two steps, and
 * neither request sees the other's uncommitted booking. The exclusion
 * constraint compares guest time only (migration 027), so a 10:00 haircut and
 * an 11:00 one -- 60 minutes each, 10 to turn the station round -- both used
 * to go in, with no time left to reset between them. lockDiaries (booking.js)
 * makes the second wait for the first to commit, after which its check
 * refuses 11:00 like any other path would.
 *
 * THIS TEST COMMITS: the first booking has to commit for the second to see
 * it, which is the thing being tested. So it runs only against a database on
 * this machine, never the live one whatever ALLOW_PRODUCTION_TESTS says, and
 * removes what it made. Its own day, eleven weeks out, so no other file
 * competes for the chair while they run at the same time.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';
import pg from 'pg';

import { createBooking } from '../api/_lib/booking.js';

const url = process.env.DATABASE_URL;
const local = Boolean(url) && /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const skip = local ? false : 'commits, so it runs only against a database on this machine';

const connect = async () => {
  const c = new pg.Client({ connectionString: url, ssl: false });
  await c.connect();
  return c;
};

const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });

test('a second booking for the same stylist waits, then is refused for squeezing the turnaround', { skip }, async (t) => {
  const a = await connect();
  const b = await connect();
  const made = [];
  try {
    const { rows: [tenant] } = await a.query("SELECT * FROM tenants WHERE slug = 'synergy'");
    const { rows: ready } = await a.query(
      `SELECT 1 FROM stylists s WHERE s.tenant_id = $1 AND s.slug = 'dina' AND s.active
          AND EXISTS (SELECT 1 FROM stylist_services x WHERE x.stylist_id = s.id)`,
      [tenant.id],
    );
    if (!ready[0]) { t.skip('needs a seeded database: Dina is not set up here'); return; }

    let day = DateTime.now().setZone(tenant.timezone).plus({ weeks: 11 }).startOf('day');
    while (day.weekday !== 2) day = day.plus({ days: 1 });
    const book = (c, hour, name) => createBooking(c, tenant, {
      serviceSlug: 'haircuts', stylistSlug: 'dina', start: day.set({ hour }).toISO(),
      guestName: name, guestPhone: '8135550177', channel: 'staff', minLeadMin: 0,
    });

    // A books 10:00 and holds its transaction open.
    await a.query('BEGIN');
    const first = await book(a, 10, 'ZZ Lock First');
    made.push(first.id);

    // B asks for 11:00 at the same moment. Without the lock it would sail
    // through now: A's booking is invisible to it until A commits.
    await b.query('BEGIN');
    const second = book(b, 11, 'ZZ Lock Second');
    second.catch(() => {});   // judged below, once A has committed
    const state = await Promise.race([
      second.then(() => 'booked', () => 'refused'),
      pause(800).then(() => 'waiting'),
    ]);
    assert.equal(state, 'waiting', 'the second booking waits for the first');

    // A commits; B's free-time check now sees 10:00 and its turnaround.
    await a.query('COMMIT');
    await assert.rejects(second, (err) => err.status === 409, '11:00 would leave no turnaround');
    await b.query('ROLLBACK');

    // A different stylist is never held up by Dina's diary.
    await b.query('BEGIN');
    await a.query('BEGIN');
    await book(a, 13, 'ZZ Lock Held');
    const other = createBooking(b, tenant, {
      serviceSlug: 'haircuts', stylistSlug: 'micah', start: day.set({ hour: 13 }).toISO(),
      guestName: 'ZZ Lock Other', guestPhone: '8135550178', channel: 'staff', minLeadMin: 0,
    }).then(() => 'booked', (err) => `refused: ${err.message}`);
    const otherState = await Promise.race([other, pause(800).then(() => 'waiting')]);
    assert.notEqual(otherState, 'waiting', 'another stylist does not wait');
    await a.query('ROLLBACK');
    await b.query('ROLLBACK');
  } finally {
    await a.query('ROLLBACK').catch(() => {});
    await b.query('ROLLBACK').catch(() => {});
    for (const id of made) {
      const { rows } = await a.query('DELETE FROM appointments WHERE id = $1 RETURNING contact_id', [id]);
      if (rows[0]?.contact_id) {
        await a.query("DELETE FROM contacts WHERE id = $1 AND name LIKE 'ZZ%'", [rows[0].contact_id]);
      }
    }
    await a.end();
    await b.end();
  }
});
