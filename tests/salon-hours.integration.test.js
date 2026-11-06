/**
 * Hours of Operation (asked for 2026-11-06): saved from Settings, Salon, by
 * the owner; read back on the Salon Profile, the public services list (the
 * website's "Open today"), the foot of emails and Karen's details. Before
 * they are set, the hours the website already showed.
 *
 * Restores the salon's hours as they were.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSession } from '../api/_lib/auth.js';
import { shopFrom } from '../api/_lib/config.js';
import { pool } from '../api/_lib/db.js';
import { ensureSchema } from '../api/_lib/ensure-schema.js';
import { DEFAULT_SALON_HOURS, hoursFrom, hoursLines, websiteHours } from '../api/_lib/hours.js';
import { tenantForUser } from '../api/_lib/tenant.js';
import services from '../api/services.js';
import business from '../api/staff/_routes/business.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

function call(route, method, { cookie = '', body, url = '/x' } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }); },
    };
    route({ method, url, headers: { cookie, host: 'localhost' }, body }, res);
  });
}

test('the hours helpers: grouped, refused when they do not make sense', () => {
  assert.deepEqual(hoursLines(null), ['Mon–Tue 9 AM – 3 PM', 'Wed–Thu 9 AM – 7 PM', 'Fri 9 AM – 6 PM', 'Sat 9 AM – 3 PM', 'Sun Closed']);
  assert.equal(websiteHours(null).Wed, '9a to 7p');
  assert.equal(websiteHours(null).Sun, 'closed');
  assert.throws(() => hoursFrom([null, { open: '10:00', close: '09:00' }, null, null, null, null, null]), /closes before it opens/);
  assert.throws(() => hoursFrom([null, { open: '10:00' }, null, null, null, null, null]), /opening and a closing time/);
  assert.throws(() => hoursFrom([null, null]), /all seven days/);
  assert.deepEqual(hoursFrom([{ closed: true }, { open: '09:30', close: '17:00' }, null, null, null, null, null])[1], { open: '09:30', close: '17:00' });
});

test('Hours of Operation: saved by the owner, shown on the profile, the website, emails and to Karen', { skip }, async () => {
  await ensureSchema();
  const db = pool();
  await db.query("DELETE FROM staff_users WHERE email LIKE 'zz-hours-%'");
  const { rows: [t] } = await db.query("SELECT id, to_jsonb(tenants) -> 'hours' AS hours FROM tenants WHERE slug = 'synergy'");
  try {
    const add = async (email, role) => (await db.query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, onboarded_at)
       VALUES ($1, $2, 'x', 'ZZ Hours', $3, now()) RETURNING *`, [t.id, email, role])).rows[0];
    const owner = await add('zz-hours-owner@example.com', 'owner');
    const stylist = await add('zz-hours-stylist@example.com', 'stylist');
    const cookieOf = async (u) => {
      const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } };
      await createSession(res, u);
      return String(res.headers['set-cookie']).split(';')[0];
    };
    const o = await cookieOf(owner);

    // Everyone reads the Salon Profile; only the owner and admins change it,
    // on the server as well as the screen (2026-11-06).
    const manager = await add('zz-hours-manager@example.com', 'manager');
    const sc = await cookieOf(stylist);
    let seen = await call(business, 'GET', { cookie: sc, url: '/api/staff/business' });
    assert.equal(seen.status, 200);
    assert.equal(seen.body.canEdit, false, 'a stylist is told it is read-only');
    assert.ok(seen.body.name && Array.isArray(seen.body.hoursText), 'and sees the name and the hours');
    assert.equal((await call(business, 'GET', { cookie: o, url: '/api/staff/business' })).body.canEdit, true);
    for (const [who, cookie] of [['stylist', sc], ['manager', await cookieOf(manager)]]) {
      for (const patch of [{ name: 'ZZ Renamed' }, { phone: '000' }, { replyTo: 'zz@example.com' }, { logo: null }]) {
        const r = await call(business, 'PATCH', { cookie, body: patch });
        assert.equal(r.status, 403, `a ${who} cannot change ${Object.keys(patch)[0]}`);
      }
    }

    // Never set: the website's own hours.
    await db.query('UPDATE tenants SET hours = NULL WHERE id = $1', [t.id]);
    let r = await call(business, 'GET', { cookie: o, url: '/api/staff/business' });
    assert.deepEqual(r.body.hours, DEFAULT_SALON_HOURS);

    const week = [null, { open: '10:00', close: '16:00' }, { open: '10:00', close: '16:00' }, null,
      { open: '08:30', close: '20:00' }, { open: '09:00', close: '18:00' }, { open: '09:00', close: '14:00' }];
    r = await call(business, 'PATCH', { cookie: await cookieOf(stylist), body: { hours: week } });
    assert.equal(r.status, 403, 'only the owner changes them');
    r = await call(business, 'PATCH', { cookie: o, body: { hours: [null, { open: '18:00', close: '09:00' }, null, null, null, null, null] } });
    assert.equal(r.status, 400);
    r = await call(business, 'PATCH', { cookie: o, body: { hours: week } });
    assert.equal(r.status, 200);

    r = await call(business, 'GET', { cookie: o, url: '/api/staff/business' });
    assert.deepEqual(r.body.hours, week);
    assert.deepEqual(r.body.hoursText, ['Mon–Tue 10 AM – 4 PM', 'Wed Closed', 'Thu 8:30 AM – 8 PM', 'Fri 9 AM – 6 PM', 'Sat 9 AM – 2 PM', 'Sun Closed']);

    // The website's "Open today" list.
    r = await call(services, 'GET', { url: '/api/services?salon=synergy' });
    assert.equal(r.body.salon.hours.Thu, '8:30a to 8p');
    assert.equal(r.body.salon.hours.Wed, 'closed');

    // The foot of emails, from the salon as every route loads it.
    const tenant = await tenantForUser(owner);
    assert.deepEqual(shopFrom(tenant).hoursLines, hoursLines(week));
  } finally {
    await db.query('UPDATE tenants SET hours = $2::jsonb WHERE id = $1', [t.id, t.hours == null ? null : JSON.stringify(t.hours)]);
    await db.query("DELETE FROM staff_sessions WHERE user_id IN (SELECT id FROM staff_users WHERE email LIKE 'zz-hours-%')");
    await db.query("DELETE FROM staff_users WHERE email LIKE 'zz-hours-%'");
  }
});
