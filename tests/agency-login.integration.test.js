/**
 * The agency's login is an admin, not a team member (asked for 2026-11-06).
 * Driven through the real /api/staff/team and /api/staff/me handlers:
 *
 * - the owner's Team list and everybody's stylist filter leave it out;
 * - it still sees itself, and still has the admin's rights;
 * - switching services on for it never makes it bookable.
 *
 * Uses the real agency address (TEAM_ADMIN_EMAILS), so it refuses to run on
 * a database where that login already exists, and removes only the rows it
 * made. Everything else is named ZZ and removed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { canManageTeam, createSession, isAgency } from '../api/_lib/auth.js';
import { TEAM_ADMIN_EMAILS } from '../api/_lib/config.js';
import { pool, query, transaction } from '../api/_lib/db.js';
import { ensureSchema } from '../api/_lib/ensure-schema.js';
import { syncStylist } from '../api/_lib/roster.js';
import me from '../api/staff/_routes/me.js';
import team from '../api/staff/_routes/team.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

function call(route, cookie) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }); },
    };
    route({ method: 'GET', url: '/api/staff/x', headers: { cookie, host: 'localhost' } }, res);
  });
}
async function sessionFor(user) {
  const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } };
  await createSession(res, user);
  return String(res.headers['set-cookie']).split(';')[0];
}

test('the agency login is an admin that is on nobody\'s team and never bookable', { skip }, async (t) => {
  await ensureSchema();
  const email = TEAM_ADMIN_EMAILS[0];
  const { rows: [tenant] } = await query("SELECT id FROM tenants WHERE slug = 'synergy'");
  const { rows: existing } = await query('SELECT 1 FROM staff_users WHERE lower(email) = $1', [email]);
  if (existing.length) { t.skip('the agency login already exists here'); return; }
  const made = [];
  try {
    const add = async (mail, name, role) => {
      const row = (await query(
        `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, onboarded_at)
         VALUES ($1, $2, 'x', $3, $4, now()) RETURNING *`, [tenant.id, mail, name, role],
      )).rows[0];
      made.push(row.id);
      return row;
    };
    const owner = await add('zz-agency-owner@example.com', 'ZZ Agency Owner', 'owner');
    const stylist = await add('zz-agency-stylist@example.com', 'ZZ Agency Stylist', 'stylist');
    const agency = await add(email, 'ZZ Agency Login', 'admin');
    assert.ok(isAgency(agency) && canManageTeam(agency));

    const names = (r) => (r.body.members || []).map((m) => m.name);
    const o = await sessionFor(owner);
    const list = await call(team, o);
    assert.equal(list.status, 200);
    assert.ok(names(list).includes('ZZ Agency Stylist'));
    assert.ok(!names(list).includes('ZZ Agency Login'), 'the owner\'s Team list leaves the agency out');
    const ome = await call(me, o);
    assert.ok(!ome.body.team.some((x) => x.name === 'ZZ Agency Login'), 'and so do the stylist filters');

    const roster = await call(team, await sessionFor(stylist));
    assert.ok(!names(roster).includes('ZZ Agency Login'), 'a stylist\'s roster leaves it out');

    const a = await sessionFor(agency);
    const own = await call(team, a);
    assert.equal(own.status, 200, 'it still runs the team');
    assert.ok(names(own).includes('ZZ Agency Login'), 'it sees itself');
    assert.ok(names(own).includes('ZZ Agency Stylist'));
    const ame = await call(me, a);
    assert.equal(ame.body.user.canManageTeam, true);
    assert.equal(ame.body.user.onboarding, false, 'no setup screens');

    // Services switched on: still not bookable.
    await transaction((db) => syncStylist(db, tenant.id, { id: agency.id, name: agency.name }, {
      services: { cuts: { on: true, price: 50, duration: 45 } },
    }));
    const { rows: chairs } = await query('SELECT 1 FROM stylists WHERE staff_user_id = $1 AND active', [agency.id]);
    assert.equal(chairs.length, 0, 'never a chair a guest can book');
  } finally {
    await query('UPDATE stylists SET staff_user_id = NULL, active = false WHERE staff_user_id = ANY($1::uuid[])', [made]);
    await query("DELETE FROM stylists WHERE name LIKE 'ZZ Agency %' AND staff_user_id IS NULL");
    await query('DELETE FROM staff_sessions WHERE user_id = ANY($1::uuid[])', [made]);
    await query('DELETE FROM staff_users WHERE id = ANY($1::uuid[])', [made]);
    await pool().end?.().catch?.(() => {});
  }
});
