/**
 * A guest books, moves and cancels through the real handlers, and none of it
 * is sent to CENTRO -- while every step still reaches the stylist's Google
 * Calendar.
 *
 *   TEST_DATABASE_URL=postgres://localhost/… npm test
 *
 * Driven through api/book.js and api/appointment.js themselves, not the
 * library under them, because that is where the CENTRO calls used to be made
 * and where the Google copy is now triggered.
 *
 * THIS TEST COMMITS: the handlers open and commit their own transactions, so
 * there is no way to roll it back. It therefore runs only against a database
 * on this machine and skips anywhere else, the live one included, whatever
 * ALLOW_PRODUCTION_TESTS says. Everything it makes is named ZZ and removed in
 * the finally.
 *
 * No email is sent: the Resend key is cleared for this process before any
 * handler runs, and the guest's address is at example.com regardless.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';
import pg from 'pg';

import { availableSlots } from '../api/_lib/availability.js';
import { setGoogleReaderForTests } from '../api/_lib/google-busy.js';
import { setGooglePushForTests } from '../api/_lib/google-mirror.js';
import { mintPreview } from '../api/_lib/preview.js';
import appointmentHandler from '../api/appointment.js';
import bookHandler from '../api/book.js';

delete process.env.RESEND_API_KEY;

const url = process.env.DATABASE_URL;
const local = Boolean(url) && /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const skip = local ? false : 'commits, so it runs only against a database on this machine';

const EMAIL = 'zz-nocentro@example.com';

/** Just enough of Vercel's request and response for handler(). */
async function call(fn, { method, path, body, headers = {} }) {
  const res = {
    statusCode: 200,
    headers: {},
    status(s) { this.statusCode = s; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    end(b) { this.body = b ? JSON.parse(b) : null; },
  };
  await fn({ method, url: path, headers, body }, res);
  return res;
}

test('booking, moving and cancelling send CENTRO nothing, and Google every step', { skip }, async (t) => {
  const c = new pg.Client({ connectionString: url, ssl: false });
  await c.connect();
  const pushed = [];
  let userId = null;
  let ref = null;
  try {
    const { rows: [tenant] } = await c.query("SELECT * FROM tenants WHERE slug = 'synergy'");
    // Kim, because the other test that commits uses Dina, and test files run
    // at the same time.
    const { rows: ready } = await c.query(
      `SELECT 1 FROM stylists s WHERE s.tenant_id = $1 AND s.slug = 'kim' AND s.active
          AND EXISTS (SELECT 1 FROM stylist_services x WHERE x.stylist_id = s.id)`,
      [tenant.id],
    );
    if (!ready[0]) { t.skip('needs a seeded database: Kim is not set up here'); return; }

    // Kim's login, with Google connected: no busy time read, and every copy
    // pushed is recorded here instead of being sent.
    const { rows: [u] } = await c.query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, google_refresh_token)
       VALUES ($1, $2, 'x', 'ZZ Kim', 'stylist', 'zz-token') RETURNING id`,
      [tenant.id, `zz-kim-${Date.now()}@example.com`],
    );
    userId = u.id;
    await c.query("UPDATE stylists SET staff_user_id = $1 WHERE tenant_id = $2 AND slug = 'kim'", [userId, tenant.id]);
    setGoogleReaderForTests(async () => []);
    setGooglePushForTests(async (uid, appt) => {
      pushed.push({ uid, status: appt.status, startsAt: new Date(appt.starts_at).toISOString() });
      await c.query(
        `INSERT INTO google_events (appointment_id, staff_user_id, event_id) VALUES ($1, $2, 'zz-event')
         ON CONFLICT (appointment_id, staff_user_id) DO UPDATE SET updated_at = now()`,
        [appt.id, uid]);
      return 'zz-event';
    });

    // Two free starts on one day six weeks out, as a guest would be offered.
    const from = DateTime.now().setZone(tenant.timezone).plus({ days: 42 });
    const { days } = await availableSlots(c, tenant, {
      serviceSlug: 'haircuts', stylistSlug: 'kim', google: true,
      fromDate: from.toISODate(), toDate: from.plus({ days: 6 }).toISODate(),
    });
    const day = days.find((d) => d.slots.length >= 8);
    assert.ok(day, 'Kim has a working day in that week');
    const [first, , , , , , , later] = day.slots.map((s) => s.start);

    // Online booking is paused, so the guest carries a staff test pass, the
    // same way a person trying the site does.
    const pass = mintPreview(tenant.id);
    const booked = await call(bookHandler, {
      method: 'POST', path: '/api/book?salon=synergy', headers: { 'x-booking-preview': pass },
      body: { service: 'haircuts', stylist: 'kim', start: first, name: 'ZZ No Centro', email: EMAIL, phone: '8135550199' },
    });
    assert.equal(booked.statusCode, 201, JSON.stringify(booked.body));
    ref = booked.body.ref;
    const manage = `/api/appointment?salon=synergy&ref=${ref}&t=${encodeURIComponent(booked.body.manageToken)}`;

    const moved = await call(appointmentHandler, { method: 'PATCH', path: manage, body: { start: later } });
    assert.equal(moved.statusCode, 200, JSON.stringify(moved.body));

    const cancelled = await call(appointmentHandler, { method: 'DELETE', path: manage });
    assert.equal(cancelled.statusCode, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.status, 'cancelled');

    // CENTRO: not one job, for the appointment or the client it made.
    const { rows: queued } = await c.query(
      `SELECT o.kind FROM sync_outbox o
         LEFT JOIN appointments a ON a.id = o.appointment_id
         LEFT JOIN contacts ct ON ct.id = o.contact_id
        WHERE a.ref = $1 OR lower(ct.email) = $2`,
      [ref, EMAIL],
    );
    assert.deepEqual(queued, [], 'nothing queued for CENTRO');

    // Google: the booking, the move and the cancellation, in that order.
    const mine = pushed.filter((p) => p.uid === userId);
    assert.deepEqual(mine.map((p) => p.status), ['booked', 'booked', 'cancelled'], JSON.stringify(mine));
    assert.equal(mine[0].startsAt, new Date(first).toISOString(), 'the booking at its time');
    assert.equal(mine[1].startsAt, new Date(later).toISOString(), 'the move at its new time');
  } finally {
    setGooglePushForTests(null);
    setGoogleReaderForTests(null);
    if (ref) await c.query('DELETE FROM appointments WHERE ref = $1', [ref]);
    await c.query('DELETE FROM contacts WHERE lower(email) = $1', [EMAIL]);
    await c.query('DELETE FROM message_sends WHERE lower(to_email) = $1', [EMAIL]).catch(() => {});
    await c.query("UPDATE stylists SET staff_user_id = NULL WHERE slug = 'kim' AND staff_user_id = $1", [userId]);
    if (userId) await c.query('DELETE FROM staff_users WHERE id = $1', [userId]);
    await c.end();
  }
});
