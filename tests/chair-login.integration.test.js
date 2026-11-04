/**
 * An Owner login and the chair without a login that is theirs (2026-11-04).
 *
 * Dina signs in as Owner, connected her Google Calendar to that login, and is
 * booked in the "Dina Lara" chair, which has no login. The two are now one
 * person wherever the app ties a chair to somebody: her column on Appt. Book
 * books with her chair and shows its visits, and a Google account with no
 * Google Calendar is named as the problem rather than "did not answer".
 * Test rows are named Zz and removed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';

import { createSession } from '../api/_lib/auth.js';
import { pool } from '../api/_lib/db.js';
import { ensureSchema } from '../api/_lib/ensure-schema.js';
import { calendarProblem } from '../api/_lib/google.js';
import diary from '../api/staff/_routes/diary.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

function call(route, cookie, path) {
  return new Promise((resolve) => {
    const out = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }); },
    };
    route({ method: 'GET', url: path, headers: { cookie, host: 'localhost' } }, out);
  });
}
async function cleanup(db) {
  await db.query("DELETE FROM appointments WHERE ref LIKE 'ZZCL%'");
  await db.query("DELETE FROM contacts WHERE name = 'ZZ CL Client'");
  await db.query("DELETE FROM stylists WHERE slug LIKE 'zz-cl-%'");
  await db.query("DELETE FROM staff_sessions WHERE user_id IN (SELECT id FROM staff_users WHERE email LIKE 'zz-cl-%')");
  await db.query("DELETE FROM staff_users WHERE email LIKE 'zz-cl-%'");
}

test('Google says why a calendar cannot be read', () => {
  assert.equal(calendarProblem(new Error('Google Calendar /x returned 403: {"reason": "notACalendarUser"}')), 'no_calendar');
  assert.equal(calendarProblem(new Error('fetch failed')), null);
});

test('an Owner login and their chair without a login are one person on Appt. Book', { skip }, async () => {
  await ensureSchema();
  const db = pool();
  await cleanup(db);
  try {
    const { rows: [t] } = await db.query("SELECT * FROM tenants WHERE slug = 'synergy'");
    const { rows: [owner] } = await db.query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, onboarded_at, google_ics)
       VALUES ($1, 'zz-cl-owner@example.com', 'x', 'Zzqora Owner', 'owner', now(),
               'https://calendar.google.com/calendar/ical/x/private-a/basic.ics') RETURNING *`, [t.id],
    );
    const { rows: [chair] } = await db.query(
      "INSERT INTO stylists (tenant_id, slug, name, active) VALUES ($1, 'zz-cl-qora', 'Zzqora Lara', true) RETURNING id", [t.id],
    );
    const { rows: [svc] } = await db.query(
      'SELECT id FROM services WHERE tenant_id = $1 AND owner_staff_id IS NULL ORDER BY sort_order LIMIT 1', [t.id],
    );
    const { rows: [c] } = await db.query(
      "INSERT INTO contacts (tenant_id, name, phone) VALUES ($1, 'ZZ CL Client', '8135550100') RETURNING id", [t.id],
    );
    const day = DateTime.now().setZone(t.timezone).plus({ days: 2 }).startOf('day');
    const start = day.set({ hour: 10 }).toISO();
    await db.query(
      `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, contact_id, starts_at, duration_min, buffer_min,
                                 during, guest_name, guest_phone, manage_token, channel)
       VALUES ($1, 'ZZCL1', $2, $3, $4, $5::timestamptz, 60, 0, tstzrange($5::timestamptz, $5::timestamptz + interval '60 minutes'),
               'ZZ CL Client', '8135550100', 'tok-zzcl1', 'staff')`,
      [t.id, chair.id, svc.id, c.id, start],
    );
    const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } };
    await createSession(res, owner);
    const cookie = String(res.headers['set-cookie']).split(';')[0];
    const d = await call(diary, cookie, `/api/staff/diary?date=${day.toISODate()}`);
    assert.equal(d.status, 200);
    const col = d.body.team.find((m) => m.id === owner.id);
    assert.equal(col?.stylistSlug, 'zz-cl-qora', 'her column books with her chair');
    assert.ok(d.body.appointments.some((a) => a.ref === 'ZZCL1'), "her chair's visit is on the book");

    // A second chair without a login of the same first name: no longer certain whose.
    await db.query("INSERT INTO stylists (tenant_id, slug, name, active) VALUES ($1, 'zz-cl-qora2', 'Zzqora Other', true)", [t.id]);
    const d2 = await call(diary, cookie, `/api/staff/diary?date=${day.toISODate()}`);
    assert.equal(d2.body.team.find((m) => m.id === owner.id)?.stylistSlug ?? null, null);
  } finally {
    await cleanup(db);
  }
});
