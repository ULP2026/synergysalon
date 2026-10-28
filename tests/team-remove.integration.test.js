/**
 * Removing somebody from the team is for good.
 *
 *   DATABASE_URL=postgres://… node --test "tests/*.test.js"
 *
 * The failure this pins: a removed member's login was deleted but their
 * stylists row (kept for its appointments) had no login left, which is what a
 * stylist who never signs in looks like, so the next load of the Team list
 * showed them again. Drives the real /api/staff/team handler as the owner.
 * Test rows are named ZZ and removed afterwards.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSession } from '../api/_lib/auth.js';
import { ensureSchema } from '../api/_lib/ensure-schema.js';
import { query } from '../api/_lib/db.js';
import team from '../api/staff/_routes/team.js';

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
    team({ method, headers: { cookie }, body }, res);
  });
}

async function cleanup() {
  await query("DELETE FROM appointments WHERE guest_name LIKE 'ZZ Remove%'");
  await query("DELETE FROM stylists WHERE slug LIKE 'zz-remove-%'");
  await query("DELETE FROM staff_users WHERE email LIKE 'zz-remove-%@example.com'");
}

test('a removed member stays removed, with or without a sign-in', { skip }, async () => {
  await ensureSchema();
  await cleanup();
  try {
    const { rows: [t] } = await query("SELECT id FROM tenants WHERE slug = 'synergy'");
    const owner = (await query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role)
       VALUES ($1, 'zz-remove-owner@example.com', 'x', 'ZZ Remove Owner', 'owner') RETURNING *`, [t.id],
    )).rows[0];
    const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } };
    await createSession(res, owner);
    const cookie = String(res.headers['set-cookie']).split(';')[0];

    // A stylist with a login and a live stylist row, as Team makes one.
    const member = (await query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, phone)
       VALUES ($1, 'zz-remove-stylist@example.com', 'x', 'ZZ Remove Stylist', 'stylist', '(813) 555-0190') RETURNING id`, [t.id],
    )).rows[0];
    await query(
      `INSERT INTO stylists (tenant_id, slug, name, staff_user_id, active)
       VALUES ($1, 'zz-remove-stylist', 'ZZ Remove Stylist', $2, true)`, [t.id, member.id],
    );
    // And one who never signs in.
    const solo = (await query(
      `INSERT INTO stylists (tenant_id, slug, name, active)
       VALUES ($1, 'zz-remove-solo', 'ZZ Remove Solo', true) RETURNING id`, [t.id],
    )).rows[0];
    // And one who stays: switched off, never signed in, never removed, like
    // the salon's own four before their services are turned on.
    await query(
      `INSERT INTO stylists (tenant_id, slug, name, active)
       VALUES ($1, 'zz-remove-keep', 'ZZ Remove Keep', false)`, [t.id],
    );

    const names = (r) => [...r.body.members, ...r.body.standalone].map((m) => m.name);
    let list = await call('GET', cookie);
    assert.equal(list.status, 200);
    assert.ok(names(list).includes('ZZ Remove Stylist'));
    assert.ok(names(list).includes('ZZ Remove Solo'));

    assert.equal((await call('POST', cookie, { id: member.id, action: 'delete' })).status, 200);
    assert.equal((await call('POST', cookie, { id: `st_${solo.id}`, action: 'delete' })).status, 200);

    // Reloaded, as a refresh would: neither comes back.
    list = await call('GET', cookie);
    assert.ok(!names(list).includes('ZZ Remove Stylist'), 'the removed member does not reappear');
    assert.ok(!names(list).includes('ZZ Remove Solo'), 'the removed stylist without a sign-in is gone too');
    // A stylist without a sign-in who was never removed is still there.
    assert.ok(names(list).includes('ZZ Remove Keep'));

    // The rows are kept for their appointments, switched off and marked.
    const { rows } = await query(
      "SELECT slug, active, removed_at FROM stylists WHERE slug IN ('zz-remove-solo', 'zz-remove-stylist')");
    assert.equal(rows.length, 2);
    for (const r of rows) { assert.equal(r.active, false); assert.ok(r.removed_at); }
    assert.equal((await query("SELECT 1 FROM staff_users WHERE email = 'zz-remove-stylist@example.com'")).rows.length, 0);
  } finally {
    await cleanup();
  }
});

test('price, timing and the shared notes are kept, with or without a sign-in', { skip }, async () => {
  await ensureSchema();
  await cleanup();
  try {
    const { rows: [t] } = await query("SELECT id FROM tenants WHERE slug = 'synergy'");
    const owner = (await query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role)
       VALUES ($1, 'zz-remove-owner@example.com', 'x', 'ZZ Remove Owner', 'owner') RETURNING *`, [t.id],
    )).rows[0];
    const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } };
    await createSession(res, owner);
    const cookie = String(res.headers['set-cookie']).split(';')[0];
    const member = (await query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, phone)
       VALUES ($1, 'zz-remove-stylist@example.com', 'x', 'ZZ Remove Stylist', 'stylist', '(813) 555-0190') RETURNING id`, [t.id],
    )).rows[0];
    const solo = (await query(
      `INSERT INTO stylists (tenant_id, slug, name, active)
       VALUES ($1, 'zz-remove-solo', 'ZZ Remove Solo', false) RETURNING id`, [t.id],
    )).rows[0];

    const services = {
      color: { on: true, price: 85.5, start: 45, break: 30, finish: 45, highlights: { start: 60, break: 40, finish: 50 } },
      cuts: { on: false, price: null, duration: 45 },
      notes: '  Patch test 48 hours before.  ',
    };
    // A stylist cannot be left without a mobile number (2026-10-28): Karen knows them by it.
    const cleared = await call('POST', cookie, { id: member.id, action: 'update', phone: '' });
    assert.equal(cleared.status, 400);
    assert.match(cleared.body.error, /A stylist needs a mobile number/);
    for (const id of [member.id, `st_${solo.id}`]) {
      assert.equal((await call('POST', cookie, { id, action: 'update', services })).status, 200);
    }
    const list = await call('GET', cookie);
    const all = [...list.body.members, ...list.body.standalone];
    for (const name of ['ZZ Remove Stylist', 'ZZ Remove Solo']) {
      const s = all.find((m) => m.name === name).services;
      assert.deepEqual(s.color, {
        on: true, price: 85.5, duration: 120, start: 45, break: 30, finish: 45,
        highlights: { start: 60, break: 40, finish: 50, duration: 150 },
      }, name);
      assert.equal(s.cuts.duration, 45);
      // One set of notes for every service, not one per service.
      assert.equal(s.notes, 'Patch test 48 hours before.', name);
    }

    // Notes saved the old way, one per service, are carried into the one box.
    const old = await call('POST', cookie, {
      id: member.id, action: 'update',
      services: { color: { on: true, notes: 'Patch test.' }, cuts: { on: true, notes: 'Dry hair.' } },
    });
    assert.equal(old.status, 200);
    const after = (await call('GET', cookie)).body.members.find((m) => m.name === 'ZZ Remove Stylist').services;
    assert.equal(after.notes, 'Cuts: Dry hair.\nColor: Patch test.');

    // A Break with nothing around it is refused.
    const lonely = await call('POST', cookie, { id: member.id, action: 'update', services: { color: { on: true, break: 30 } } });
    assert.equal(lonely.status, 400);

    // A length that is not whole minutes in range is refused, not stored.
    const bad = await call('POST', cookie, { id: member.id, action: 'update', services: { color: { on: true, duration: 2 } } });
    assert.equal(bad.status, 400);
  } finally {
    await cleanup();
  }
});
