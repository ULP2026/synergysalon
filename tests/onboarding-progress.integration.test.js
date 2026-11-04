/**
 * Onboarding keeps its place, and a stylist's own services stay theirs
 * (asked for 2026-11-04), through the real endpoints against Postgres.
 *
 * - The step somebody is on is saved and given back, so a reload or signing
 *   in again resumes there, and it is cleared when they finish.
 * - A service a stylist adds is offered with them and nobody else, even a
 *   stylist with the same kind switched on; it carries its own price; a
 *   name already on the list is refused; dropping it, or removing them from
 *   the team, switches it off rather than handing it to the salon.
 *
 * Commits ZZ rows (sessions need a real user), and removes them after.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSession } from '../api/_lib/auth.js';
import { pool } from '../api/_lib/db.js';
import { ensureSchema } from '../api/_lib/ensure-schema.js';
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
  await db.query("DELETE FROM stylist_services WHERE stylist_id IN (SELECT id FROM stylists WHERE name LIKE 'ZZ OP %')");
  await db.query("DELETE FROM stylist_hours WHERE stylist_id IN (SELECT id FROM stylists WHERE name LIKE 'ZZ OP %')");
  await db.query("DELETE FROM stylists WHERE name LIKE 'ZZ OP %'");
  await db.query("DELETE FROM services WHERE name LIKE 'ZZ OP %'");
  await db.query("DELETE FROM staff_sessions WHERE user_id IN (SELECT id FROM staff_users WHERE email LIKE 'zz-op-%')");
  await db.query("DELETE FROM staff_users WHERE email LIKE 'zz-op-%'");
}

test('onboarding resumes where it stopped, and a stylist\'s own service is theirs alone', { skip }, async () => {
  const db = pool();
  await ensureSchema();
  await cleanup(db);
  try {
    const { rows: [t] } = await db.query("SELECT id FROM tenants WHERE slug = 'synergy'");
    const add = async (email, name, role, onboarded) => (await db.query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, phone, onboarded_at)
       VALUES ($1, $2, 'x', $3, $4, '8135550147', ${onboarded ? 'now()' : 'NULL'}) RETURNING *`, [t.id, email, name, role],
    )).rows[0];
    const owner = await add('zz-op-owner@example.com', 'ZZ OP Owner', 'owner', true);
    const nina = await add('zz-op-nina@example.com', 'ZZ OP Nina', 'stylist', false);
    const other = await add('zz-op-other@example.com', 'ZZ OP Other', 'stylist', true);
    const n = await sessionFor(nina);
    const o = await sessionFor(owner);
    const x = await sessionFor(other);

    // ── the step is kept ──
    assert.equal((await call(profile, n, 'GET', '/api/staff/profile')).body.onboardingStep, null, 'nothing saved yet');
    assert.equal((await call(profile, n, 'PATCH', '/api/staff/profile', { onboardingStep: 'hours' })).status, 200);
    assert.equal((await call(profile, n, 'GET', '/api/staff/profile')).body.onboardingStep, 'hours', 'resumes at hours');
    await call(profile, n, 'PATCH', '/api/staff/profile', { name: 'ZZ OP Nina', onboardingStep: 'not-a-step' });
    assert.equal((await call(profile, n, 'GET', '/api/staff/profile')).body.onboardingStep, 'hours', 'an unknown step is ignored');

    // ── a service of her own ──
    const own = [{ name: 'ZZ OP Fringe Fix', category: 'cuts', price: 20, duration: 25, description: 'A quick tidy', on: true }];
    const saved = await call(profile, n, 'PATCH', '/api/staff/profile', { ownServices: own, services: { cuts: { on: false } } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const back = (await call(profile, n, 'GET', '/api/staff/profile')).body;
    assert.equal(back.ownServices.length, 1);
    const [fix] = back.ownServices;
    assert.match(fix.slug, /^own-/);
    assert.equal(fix.price, 20);
    assert.equal(fix.duration, 25);
    assert.equal(back.services.items[fix.slug].price, 20, 'its price is in her services, where prices live');

    const offers = async (who) => (await db.query(
      `SELECT v.slug FROM stylist_services ss JOIN stylists s ON s.id = ss.stylist_id
         JOIN services v ON v.id = ss.service_id WHERE s.staff_user_id = $1`, [who.id],
    )).rows.map((r) => r.slug);
    assert.deepEqual(await offers(nina), [fix.slug], 'offered with her, though her Cuts switch is off');

    // Another stylist with Cuts on gets the salon's cuts, never hers.
    await call(profile, x, 'PATCH', '/api/staff/profile', { services: { cuts: { on: true } } });
    const theirs = await offers(other);
    assert.ok(theirs.length > 0 && !theirs.includes(fix.slug), 'not offered with anybody else');
    const xMe = (await call(me, x, 'GET', '/api/staff/me')).body;
    assert.ok(!xMe.services.some((s) => s.slug === fix.slug), 'not on another stylist\'s list');
    const oMe = (await call(me, o, 'GET', '/api/staff/me')).body;
    assert.equal(oMe.services.find((s) => s.slug === fix.slug)?.owner, nina.id, 'the owner sees whose it is');

    // Nobody in the salon but her offers it: the booking engine, the
    // website's menu and the desk all read who offers what from here.
    const { rows: withIt } = await db.query(
      `SELECT s.name FROM stylist_services ss JOIN stylists s ON s.id = ss.stylist_id
         JOIN services v ON v.id = ss.service_id WHERE v.slug = $1 AND v.tenant_id = $2`, [fix.slug, t.id],
    );
    assert.deepEqual(withIt.map((r) => r.name), ['ZZ OP Nina']);

    // A name already on the list is refused.
    const { rows: [salon] } = await db.query(
      'SELECT name FROM services WHERE tenant_id = $1 AND active AND owner_staff_id IS NULL ORDER BY sort_order LIMIT 1', [t.id],
    );
    const dup = await call(profile, n, 'PATCH', '/api/staff/profile', {
      ownServices: [...back.ownServices, { name: salon.name, category: 'cuts', price: 10, duration: 30 }],
    });
    assert.equal(dup.status, 409);
    // A price and minutes are required.
    const bare = await call(profile, n, 'PATCH', '/api/staff/profile', { ownServices: [{ name: 'ZZ OP Bare', category: 'styling' }] });
    assert.equal(bare.status, 400);

    // Dropped from her list: switched off, kept for any appointment.
    await call(profile, n, 'PATCH', '/api/staff/profile', { ownServices: [], services: { cuts: { on: true } } });
    const { rows: [gone] } = await db.query('SELECT active FROM services WHERE slug = $1 AND tenant_id = $2', [fix.slug, t.id]);
    assert.equal(gone.active, false);
    assert.ok(!(await offers(nina)).includes(fix.slug));

    // ── finishing clears the step ──
    await call(profile, n, 'PATCH', '/api/staff/profile', { hours: [{ weekday: 3, starts: '10:00', ends: '15:00' }] });
    const done = await call(profile, n, 'PATCH', '/api/staff/profile', { finishOnboarding: true });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const after = (await call(profile, n, 'GET', '/api/staff/profile')).body;
    assert.equal(after.onboarding, false);
    assert.equal(after.onboardingStep, null);

    // ── removing her switches her own services off ──
    await call(profile, n, 'PATCH', '/api/staff/profile', {
      ownServices: [{ name: 'ZZ OP Gloss', category: 'color', price: 45, duration: 40 }],
    });
    const del = await call(team, o, 'POST', '/api/staff/team', { id: nina.id, action: 'delete' });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    const { rows: [gloss] } = await db.query("SELECT active FROM services WHERE name = 'ZZ OP Gloss' AND tenant_id = $1", [t.id]);
    assert.equal(gloss.active, false, 'not handed to the salon');
  } finally {
    await cleanup(db);
  }
});
