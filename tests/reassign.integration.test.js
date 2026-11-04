/**
 * A stylist removed from the team never strands their clients (asked for
 * 2026-11-04, after a removed "Luis Lara" still held booked appointments in
 * a chair nobody works).
 *
 * - Removing somebody with appointments still to come is refused until the
 *   owner says who takes them (or plainly chooses to move them later).
 * - Given a stylist, each visit moves to them at its own time, through the
 *   desk's move, and only then is the person removed.
 * - A visit the new stylist cannot take stays put, with why, and stops the
 *   removal.
 * - A chair already removed can still hand its visits on.
 * - Past visits stay with whoever did them.
 *
 * Runs in a throwaway ZZ tenant and removes it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';

import { createSession } from '../api/_lib/auth.js';
import { pool } from '../api/_lib/db.js';
import team from '../api/staff/_routes/team.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
const TZ = 'America/New_York';
const SLUG = 'zz-reassign';

let DAY = DateTime.now().setZone(TZ).plus({ days: 20 }).startOf('day');
while (DAY.weekday !== 6) DAY = DAY.plus({ days: 1 });
const at = (h) => DAY.set({ hour: h });

const cleanup = async () => {
  await pool().query("DELETE FROM staff_users WHERE email LIKE 'zz-reassign-%@example.com'");
  await pool().query('DELETE FROM tenants WHERE slug = $1', [SLUG]);
};

function call(cookie, body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }); },
    };
    team({ method: 'POST', headers: { cookie }, body }, res);
  });
}

test('a removed stylist\'s upcoming appointments are handed on, never stranded', { skip }, async () => {
  await cleanup();
  const db = pool();
  try {
    const t = (await db.query(
      `INSERT INTO tenants (slug, name, timezone) VALUES ($1, 'ZZ Reassign', $2) RETURNING *`, [SLUG, TZ],
    )).rows[0];
    const v = (await db.query(
      `INSERT INTO services (tenant_id, slug, name, category, duration_min, buffer_min)
       VALUES ($1, 'zz-cut', 'ZZ Cut', 'cuts', 60, 0) RETURNING id`, [t.id],
    )).rows[0].id;
    const owner = (await db.query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role)
       VALUES ($1, 'zz-reassign-owner@example.com', 'x', 'ZZ Owner', 'owner') RETURNING *`, [t.id],
    )).rows[0];
    // Two logins with the same name, as on the salon's Appt. Book: the old
    // one (to be removed) and the new one.
    const chair = async (email, slug) => {
      const u = (await db.query(
        `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, phone)
         VALUES ($1, $2, 'x', 'ZZ Luis Lara', 'stylist', '8135550190') RETURNING id`, [t.id, email],
      )).rows[0].id;
      const s = (await db.query(
        `INSERT INTO stylists (tenant_id, slug, name, staff_user_id, service_details)
         VALUES ($1, $2, 'ZZ Luis Lara', $3, '{"lunch": false}'::jsonb) RETURNING id`, [t.id, slug, u],
      )).rows[0].id;
      await db.query('INSERT INTO stylist_services (stylist_id, service_id) VALUES ($1, $2)', [s, v]);
      await db.query(
        "INSERT INTO stylist_hours (stylist_id, weekday, starts_at, ends_at) VALUES ($1, 6, '09:00', '17:00')", [s],
      );
      return { user: u, stylist: s };
    };
    const old = await chair('zz-reassign-old@example.com', 'zz-luis-old');
    const neu = await chair('zz-reassign-new@example.com', 'zz-luis-new');
    const appt = async (stylist, start, ref) => db.query(
      `INSERT INTO appointments (tenant_id, ref, manage_token, stylist_id, service_id, starts_at, duration_min,
                                 buffer_min, during, guest_name, guest_email, channel, status)
       VALUES ($1, $2, 'zz-token-' || $2, $3, $4, $5::timestamptz, 60, 0,
               tstzrange($5::timestamptz, $5::timestamptz + interval '60 minutes', '[)'),
               'ZZ Cisco Sauce', 'zz-reassign@example.com', 'staff', $6::appointment_status)`,
      [t.id, ref, stylist, v, start.toISO(), start < DateTime.now() ? 'completed' : 'booked'],
    );
    await appt(old.stylist, at(10), 'ZZRA1');
    await appt(old.stylist, at(13), 'ZZRA2');
    await appt(neu.stylist, at(13), 'ZZRB1');                       // the new chair is busy at 1
    await appt(old.stylist, DateTime.now().minus({ days: 3 }).set({ hour: 11 }), 'ZZRA0');   // a past visit

    const res = { headers: {}, setHeader(k, val) { this.headers[k.toLowerCase()] = val; } };
    await createSession(res, owner);
    const cookie = String(res.headers['set-cookie']).split(';')[0];
    const where = async (ref) => (await db.query(
      'SELECT s.slug FROM appointments a JOIN stylists s ON s.id = a.stylist_id WHERE a.ref = $1', [ref],
    )).rows[0].slug;

    // 1. Removing with appointments to come is refused, and says which.
    let r = await call(cookie, { id: old.user, action: 'delete' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'HAS_APPOINTMENTS');
    assert.deepEqual(r.body.upcoming.map((a) => a.ref).sort(), ['ZZRA1', 'ZZRA2']);
    assert.ok((await db.query('SELECT 1 FROM staff_users WHERE id = $1', [old.user])).rows[0], 'not removed');

    // 2. Handing them on: the 10 o'clock moves; the 1 o'clock cannot (the
    //    new chair is booked then), so the removal stops with why.
    r = await call(cookie, { id: old.user, action: 'delete', reassignTo: 'zz-luis-new', notify: false });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'REASSIGN_INCOMPLETE');
    assert.deepEqual(r.body.upcoming.map((a) => a.ref), ['ZZRA2']);
    assert.ok(r.body.upcoming[0].reason);
    assert.equal(await where('ZZRA1'), 'zz-luis-new');
    assert.equal(await where('ZZRA2'), 'zz-luis-old');
    assert.ok((await db.query('SELECT 1 FROM staff_users WHERE id = $1', [old.user])).rows[0], 'still not removed');

    // 3. The owner chooses to move the rest later: removed, chair kept and marked.
    r = await call(cookie, { id: old.user, action: 'delete', keepAppointments: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const { rows: [gone] } = await db.query('SELECT active, removed_at FROM stylists WHERE id = $1', [old.stylist]);
    assert.equal(gone.active, false);
    assert.ok(gone.removed_at);

    // 4. From the removed chair later, once the 1 o'clock is free.
    await db.query("UPDATE appointments SET status = 'cancelled' WHERE ref = 'ZZRB1'");
    r = await call(cookie, { action: 'upcoming', from: 'zz-luis-old' });
    assert.deepEqual(r.body.upcoming.map((a) => a.ref), ['ZZRA2']);
    r = await call(cookie, { action: 'reassign', from: 'zz-luis-old', to: 'zz-luis-new', notify: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.moved.map((a) => a.ref), ['ZZRA2']);
    assert.equal(r.body.skipped.length, 0);
    assert.equal(await where('ZZRA2'), 'zz-luis-new');

    // Past visits stay with whoever did them.
    assert.equal(await where('ZZRA0'), 'zz-luis-old');
    // Nobody is moved to a chair that is not taking bookings.
    r = await call(cookie, { action: 'reassign', from: 'zz-luis-new', to: 'zz-luis-old' });
    assert.equal(r.status, 400);
  } finally {
    await cleanup();
  }
});
