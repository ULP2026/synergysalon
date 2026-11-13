/**
 * Skin, a fifth kind (Luis, 2026-11-13): Eyebrow Wax and Lip Wax are on the
 * salon's list under Skin, and a stylist who had added either as their own
 * service now offers the salon's one, at their own price and minutes, with
 * the old one switched off and every chair that offered it offering the new
 * one. Running the migration twice changes nothing more. The team's form
 * keeps Skin like any other kind. Inside a transaction that is rolled back.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import pg from 'pg';

import { servicesFrom } from '../api/staff/_routes/profile.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const isLocal = url?.includes('localhost') || url?.includes('127.0.0.1');

test('the team form keeps Skin as a kind', () => {
  const s = servicesFrom({ skin: { on: true }, items: { 'eyebrow-wax': { on: true, price: 19, duration: 20 } } });
  assert.equal(s.skin.on, true);
  assert.deepEqual(s.items['eyebrow-wax'], { on: true, duration: 20, price: 19 });
});

test('own Eyebrow Wax and Lip Wax move onto the salon\'s Skin services', { skip }, async () => {
  const c = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await c.connect();
  const sql = await readFile(new URL('../db/migrations/062-skin.sql', import.meta.url), 'utf8');
  try {
    await c.query('BEGIN');
    const { rows: [t] } = await c.query("SELECT id FROM tenants WHERE slug = 'synergy'");
    const { rows: [u] } = await c.query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, onboarded_at, services)
       VALUES ($1, 'zz-skin@example.com', 'x', 'ZZ Skin', 'stylist', now(), $2::jsonb) RETURNING id`,
      [t.id, JSON.stringify({ cuts: { on: true }, items: { 'own-zzskin-eyebrow-wax': { on: true, price: 19, duration: 20 }, 'own-zzskin-lip-wax': { on: true, price: 17, duration: 10 } } })],
    );
    const own = async (slug, name) => (await c.query(
      `INSERT INTO services (tenant_id, slug, name, category, blurb, duration_min, owner_staff_id, sort_order)
       VALUES ($1, $2, $3, 'treatments', '', 15, $4, 999) RETURNING id`, [t.id, slug, name, u.id],
    )).rows[0].id;
    const brow = await own('own-zzskin-eyebrow-wax', 'Eyebrow Wax');
    const lip = await own('own-zzskin-lip-wax', 'lip wax ');
    const { rows: [chair] } = await c.query(
      "INSERT INTO stylists (tenant_id, slug, name, active, staff_user_id) VALUES ($1, 'zz-skin', 'ZZ Skin', true, $2) RETURNING id",
      [t.id, u.id],
    );
    for (const id of [brow, lip]) await c.query('INSERT INTO stylist_services (stylist_id, service_id) VALUES ($1, $2)', [chair.id, id]);

    await c.query(sql);
    await c.query(sql);   // twice: nothing more happens

    const { rows: list } = await c.query(
      "SELECT slug, name, category, active FROM services WHERE tenant_id = $1 AND slug IN ('eyebrow-wax', 'lip-wax') ORDER BY slug", [t.id],
    );
    assert.deepEqual(list.map((r) => [r.slug, r.name, r.category, r.active]),
      [['eyebrow-wax', 'Eyebrow Wax', 'skin', true], ['lip-wax', 'Lip Wax', 'skin', true]]);

    const { rows: [after] } = await c.query('SELECT services FROM staff_users WHERE id = $1', [u.id]);
    assert.equal(after.services.skin.on, true);
    assert.equal(after.services.cuts.on, true, 'other kinds untouched');
    assert.deepEqual(after.services.items['eyebrow-wax'], { on: true, price: 19, duration: 20 });
    assert.deepEqual(after.services.items['lip-wax'], { on: true, price: 17, duration: 10 });

    const { rows: old } = await c.query('SELECT active FROM services WHERE id = ANY($1::uuid[])', [[brow, lip]]);
    assert.ok(old.every((r) => r.active === false), 'the own copies are switched off');
    const { rows: offered } = await c.query(
      `SELECT v.slug FROM stylist_services ss JOIN services v ON v.id = ss.service_id
        WHERE ss.stylist_id = $1 AND v.active ORDER BY v.slug`, [chair.id],
    );
    assert.deepEqual(offered.map((r) => r.slug), ['eyebrow-wax', 'lip-wax']);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});
