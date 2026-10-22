/**
 * An owner can be a stylist too.
 *
 *   TEST_DATABASE_URL=postgres://localhost/… npm test
 *
 * The owner's own window used to leave out services, prices and hours, and
 * /api/staff/profile threw away any it was sent, on the rule that the person
 * who runs the place takes no appointments. Asked to change on 2026-10-22: an
 * owner who also does hair sets their prices and hours like anybody else.
 * Drives the real profile handler as an owner, in a ZZ salon of its own that
 * it removes afterwards.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSession } from '../api/_lib/auth.js';
import { pool } from '../api/_lib/db.js';
import profile from '../api/staff/_routes/profile.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

/** Enough of a Node request and response for handler() and json(). */
function call(method, cookie, body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }); },
    };
    profile({ method, url: '/api/staff/profile', headers: { cookie }, body }, res);
  });
}

const drop = () => pool().query("DELETE FROM tenants WHERE slug = 'zz-owner'");

test('an owner sets their own services and hours, and is bookable', { skip }, async () => {
  await drop();
  const db = pool();
  try {
    const tenant = (await db.query(
      "INSERT INTO tenants (slug, name, timezone) VALUES ('zz-owner', 'ZZ Owner', 'America/New_York') RETURNING id",
    )).rows[0];
    await db.query(
      `INSERT INTO services (tenant_id, slug, name, category, duration_min, buffer_min)
       VALUES ($1, 'zz-cut', 'ZZ Cut', 'cuts', 60, 15)`, [tenant.id],
    );
    const owner = (await db.query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role)
       VALUES ($1, 'zz-owner@example.com', 'x', 'ZZ Owner Dana', 'owner') RETURNING *`, [tenant.id],
    )).rows[0];
    const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } };
    await createSession(res, owner);
    const cookie = String(res.headers['set-cookie']).split(';')[0];

    const saved = await call('PATCH', cookie, {
      services: { cuts: { on: true, price: 65, duration: 45 } },
      hours: [{ weekday: 6, starts: '09:00', ends: '15:00' }],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.services.cuts.on, true, 'the owner keeps the services they sent');
    assert.equal(saved.body.services.cuts.price, 65);

    // On the diary: an active stylist row, their own, offering cuts, with
    // the hours they set.
    const { rows: [st] } = await db.query(
      'SELECT id, active FROM stylists WHERE tenant_id = $1 AND staff_user_id = $2', [tenant.id, owner.id]);
    assert.ok(st, 'the owner has a stylist row');
    assert.equal(st.active, true);
    const { rows: svcs } = await db.query(
      `SELECT v.category FROM stylist_services x JOIN services v ON v.id = x.service_id
        WHERE x.stylist_id = $1`, [st.id]);
    assert.deepEqual(svcs.map((s) => s.category), ['cuts']);
    const { rows: hrs } = await db.query('SELECT weekday FROM stylist_hours WHERE stylist_id = $1', [st.id]);
    assert.deepEqual(hrs.map((h) => h.weekday), [6]);

    // Everything off: off the booking page again, still on the team.
    const off = await call('PATCH', cookie, { services: { cuts: { on: false } } });
    assert.equal(off.status, 200);
    const { rows: [after] } = await db.query('SELECT active FROM stylists WHERE id = $1', [st.id]);
    assert.equal(after.active, false);
  } finally {
    await drop();
  }
});
