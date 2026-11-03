/**
 * Onboarding and who sees what (asked for 2026-11-03), through the real
 * endpoints with real sessions against Postgres.
 *
 * - Somebody added to the team is refused everything but their own account
 *   until they finish setting it up; a stylist cannot finish without a
 *   mobile number; once finished, the app opens to them.
 * - Only the owner sees everyone's calendar, appointments and clients;
 *   anyone else, stylists included, sees their own chair and their own
 *   account only, and cannot open or change anybody else's.
 *
 * Commits ZZ rows (sessions need a real user), and removes them after.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';

import { createSession } from '../api/_lib/auth.js';
import { pool } from '../api/_lib/db.js';
import appointment from '../api/staff/_routes/appointment.js';
import business from '../api/staff/_routes/business.js';
import contacts from '../api/staff/_routes/contacts.js';
import diary from '../api/staff/_routes/diary.js';
import home from '../api/staff/_routes/home.js';
import me from '../api/staff/_routes/me.js';
import profile from '../api/staff/_routes/profile.js';
import team from '../api/staff/_routes/team.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';

/** Calls a route handler as Vercel would, with this person's session. */
async function call(route, cookie, method, path, body) {
  return new Promise((resolve) => {
    const out = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }); },
    };
    route({ method, url: path, headers: { cookie, host: 'localhost' }, body }, out);
  });
}

async function sessionFor(user) {
  const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } };
  await createSession(res, user);
  return String(res.headers['set-cookie']).split(';')[0];
}

async function cleanup(db) {
  await db.query("DELETE FROM appointments WHERE ref LIKE 'ZZOB%'");
  await db.query("DELETE FROM contacts WHERE name LIKE 'ZZ OB %'");
  await db.query("UPDATE stylists SET staff_user_id = NULL WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email LIKE 'zz-ob-%')");
  await db.query("DELETE FROM stylists WHERE slug LIKE 'zz-ob-%'");
  await db.query("DELETE FROM staff_sessions WHERE user_id IN (SELECT id FROM staff_users WHERE email LIKE 'zz-ob-%')");
  await db.query("DELETE FROM staff_users WHERE email LIKE 'zz-ob-%'");
}

test('a new stylist sets up their account first, then sees only their own chair', { skip }, async () => {
  const db = pool();
  await cleanup(db);
  try {
    const { rows: [t] } = await db.query("SELECT id, timezone FROM tenants WHERE slug = 'synergy'");
    const add = async (email, name, role, onboarded) => (await db.query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, onboarded_at)
       VALUES ($1, $2, 'x', $3, $4, ${onboarded ? 'now()' : 'NULL'}) RETURNING *`, [t.id, email, name, role],
    )).rows[0];
    const owner = await add('zz-ob-owner@example.com', 'ZZ OB Owner', 'owner', false);
    const nina = await add('zz-ob-nina@example.com', 'ZZ OB Nina', 'stylist', false);
    const other = await add('zz-ob-other@example.com', 'ZZ OB Other', 'stylist', true);
    // Each a chair: Nina's, and another stylist's with a client of their own.
    const chair = async (slug, name, userId) => (await db.query(
      `INSERT INTO stylists (tenant_id, slug, name, active, staff_user_id) VALUES ($1, $2, $3, true, $4) RETURNING id`,
      [t.id, slug, name, userId],
    )).rows[0].id;
    const ninaChair = await chair('zz-ob-nina', 'ZZ OB Nina', nina.id);
    const otherChair = await chair('zz-ob-other', 'ZZ OB Other', other.id);
    const { rows: [svc] } = await db.query("SELECT id FROM services WHERE tenant_id = $1 ORDER BY sort_order LIMIT 1", [t.id]);
    const day = DateTime.now().setZone(t.timezone).plus({ days: 2 }).startOf('day');
    const book = async (ref, stylistId, name, hour) => {
      const { rows: [c] } = await db.query(
        "INSERT INTO contacts (tenant_id, name, email, phone) VALUES ($1, $2, '', '8135550100') RETURNING id", [t.id, name],
      );
      const start = day.set({ hour }).toISO();
      await db.query(
        `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, contact_id, starts_at, duration_min, buffer_min,
                                   during, guest_name, guest_email, guest_phone, manage_token, channel)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, 60, 0, tstzrange($6::timestamptz, $6::timestamptz + interval '60 minutes'),
                 $7, '', '8135550100', $8, 'staff')`,
        [t.id, ref, stylistId, svc.id, c.id, start, name, `tok-${ref}`],
      );
      return c.id;
    };
    const ninaClient = await book('ZZOB1', ninaChair, 'ZZ OB Nina Client', 10);
    const otherClient = await book('ZZOB2', otherChair, 'ZZ OB Other Client', 11);

    const n = await sessionFor(nina);
    const o = await sessionFor(owner);
    const date = day.toISODate();

    // ── onboarding ──
    const meNow = await call(me, n, 'GET', '/api/staff/me');
    assert.equal(meNow.status, 200, 'who they are is open, so the console can show the setup');
    assert.equal(meNow.body.user.onboarding, true);
    for (const [route, path] of [[diary, `/api/staff/diary?date=${date}`], [contacts, '/api/staff/contacts?q='],
      [home, '/api/staff/home']]) {
      const r = await call(route, n, 'GET', path);
      assert.equal(r.status, 403, `${path} is closed while setting up`);
      assert.equal(r.body.code, 'ONBOARDING');
    }
    assert.equal((await call(profile, n, 'GET', '/api/staff/profile')).status, 200, 'their own account is open');
    // A stylist cannot finish without the mobile Karen knows them by.
    const early = await call(profile, n, 'PATCH', '/api/staff/profile', { finishOnboarding: true });
    assert.equal(early.status, 400);
    assert.equal((await call(profile, n, 'PATCH', '/api/staff/profile', { phone: '(813) 555-0144' })).status, 200);
    const done = await call(profile, n, 'PATCH', '/api/staff/profile', { finishOnboarding: true });
    assert.equal(done.status, 200);
    assert.equal(done.body.onboarded, true);
    assert.equal((await call(me, n, 'GET', '/api/staff/me')).body.user.onboarding, false);
    // The owner is never held, onboarded_at or not.
    assert.equal((await call(me, o, 'GET', '/api/staff/me')).body.user.onboarding, false);

    // ── who sees what ──
    const ninaDay = await call(diary, n, 'GET', `/api/staff/diary?date=${date}`);
    assert.equal(ninaDay.status, 200);
    assert.deepEqual(ninaDay.body.appointments.map((a) => a.ref), ['ZZOB1'], 'only her own chair');
    const ownerDay = await call(diary, o, 'GET', `/api/staff/diary?date=${date}`);
    const ownerRefs = ownerDay.body.appointments.map((a) => a.ref);
    assert.ok(ownerRefs.includes('ZZOB1') && ownerRefs.includes('ZZOB2'), 'the owner sees everyone');

    const list = await call(contacts, n, 'GET', '/api/staff/contacts?q=ZZ%20OB&stylists=1');
    assert.deepEqual(list.body.contacts.map((c) => c.name), ['ZZ OB Nina Client']);
    assert.deepEqual(list.body.stylists.map((s) => s.name), ['ZZ OB Nina']);
    assert.equal((await call(contacts, n, 'GET', `/api/staff/contacts?id=${ninaClient}`)).status, 200);
    assert.equal((await call(contacts, n, 'GET', `/api/staff/contacts?id=${otherClient}`)).status, 404, "another stylist's client");
    assert.equal((await call(contacts, n, 'PATCH', '/api/staff/contacts', { id: otherClient, op: 'note', note: 'ZZ no' })).status, 404);
    assert.equal((await call(contacts, o, 'GET', `/api/staff/contacts?id=${otherClient}`)).status, 200);

    assert.equal((await call(appointment, n, 'GET', '/api/staff/appointment?ref=ZZOB1')).status, 200);
    assert.equal((await call(appointment, n, 'GET', '/api/staff/appointment?ref=ZZOB2')).status, 404);
    const act = await call(appointment, n, 'POST', '/api/staff/appointment', { ref: 'ZZOB2', action: 'cancel' });
    assert.equal(act.status, 404, "cannot cancel another stylist's appointment");
    const { rows: [still] } = await db.query("SELECT status FROM appointments WHERE ref = 'ZZOB2'");
    assert.equal(still.status, 'booked');

    // Salon settings are the owner's: the team, the salon profile, Karen.
    assert.equal((await call(team, n, 'GET', '/api/staff/team')).status, 403, 'the team is the owner\'s');
    assert.equal((await call(business, n, 'GET', '/api/staff/business')).status, 403, 'the salon profile is the owner\'s');
    assert.equal((await call(business, n, 'PATCH', '/api/staff/business', { name: 'ZZ no' })).status, 403);
    // Their own services, prices and hours are theirs to set, in My Settings.
    const hours = [{ weekday: 1, starts: '10:00', ends: '16:00' }];
    const mine = await call(profile, n, 'PATCH', '/api/staff/profile', { title: 'ZZ Colorist', hours, services: { cuts: { on: true } } });
    assert.equal(mine.status, 200);
    const back = await call(profile, n, 'GET', '/api/staff/profile');
    assert.equal(back.body.title, 'ZZ Colorist');
    assert.ok((back.body.hours || []).some((h) => Number(h.weekday) === 1), 'their own hours are kept');
    const ownerTeam = await call(team, o, 'GET', '/api/staff/team');
    assert.ok(ownerTeam.body.members.some((m) => m.name === 'ZZ OB Other'));

    const homeView = await call(home, n, 'GET', '/api/staff/home');
    assert.deepEqual(homeView.body.upcoming.map((a) => a.guestName), ['ZZ OB Nina Client']);

    assert.equal((await call(business, n, 'GET', '/api/staff/business?history=1')).status, 403, 'the email log is the owner\'s');
    assert.equal((await call(business, o, 'GET', '/api/staff/business?history=1')).status, 200);
  } finally {
    await cleanup(db);
  }
});
