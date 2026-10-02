/**
 * Saving a team member keeps the booking side in step.
 *
 *   DATABASE_URL=postgres://… node --test "tests/*.test.js"
 *
 * readHours is unit tested; this is the half that touches four tables. Every
 * test runs inside a transaction that is rolled back, so nothing survives even
 * when an assertion fails partway through.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { pool } from '../api/_lib/db.js';
import { hoursFor, syncStylist } from '../api/_lib/roster.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

const ON = (...kinds) => Object.fromEntries(kinds.map((k) => [k, { on: true, price: 50 }]));

/** A throwaway salon with one member of staff and the four categories. */
async function scaffold(client) {
  const tenant = (await client.query(
    `INSERT INTO tenants (slug, name, timezone)
     VALUES ('zz-roster', 'ZZ Roster', 'America/New_York') RETURNING id`,
  )).rows[0];
  for (const [slug, category] of [
    ['zz-cut', 'cuts'], ['zz-tone', 'color'], ['zz-blow', 'styling'], ['zz-mask', 'treatments'],
  ]) {
    await client.query(
      `INSERT INTO services (tenant_id, slug, name, category, duration_min, buffer_min)
       VALUES ($1, $2, $2, $3, 60, 0)`,
      [tenant.id, slug, category],
    );
  }
  const user = (await client.query(
    `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, status)
     VALUES ($1, 'zz-roster@example.com', 'x', 'ZZ Jessi', 'front_desk', 'active')
     RETURNING id, name`,
    [tenant.id],
  )).rows[0];
  return { tenant, user: { ...user, username: 'zz.jessi' } };
}

const stylistRow = (client, tenantId, userId) => client.query(
  'SELECT id, slug, name, active FROM stylists WHERE tenant_id = $1 AND staff_user_id = $2',
  [tenantId, userId],
).then((r) => r.rows[0] ?? null);

const serviceSlugs = (client, stylistId) => client.query(
  `SELECT v.slug FROM stylist_services ss JOIN services v ON v.id = ss.service_id
    WHERE ss.stylist_id = $1 ORDER BY v.slug`,
  [stylistId],
).then((r) => r.rows.map((x) => x.slug));

/** Runs one case inside a transaction and always rolls it back. */
async function inRollback(fn) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

test('switching a service on is what makes somebody bookable', { skip }, async () => {
  await inRollback(async (client) => {
    const { tenant, user } = await scaffold(client);

    assert.equal(await stylistRow(client, tenant.id, user.id), null,
      'nobody is on the booking page until a service is switched on');

    await syncStylist(client, tenant.id, user, {
      services: ON('cuts', 'color'),
      hours: [{ weekday: 2, starts: '10:00', ends: '18:00' }],
    });

    const s = await stylistRow(client, tenant.id, user.id);
    assert.ok(s, 'a stylist row should exist');
    assert.equal(s.active, true);
    assert.equal(s.name, 'ZZ Jessi');
    assert.equal(s.slug, 'zz-jessi', 'the slug comes from their username');
    assert.deepEqual(await serviceSlugs(client, s.id), ['zz-cut', 'zz-tone']);
    assert.deepEqual(await hoursFor(client, tenant.id, user.id),
      [{ weekday: 2, starts: '10:00', ends: '18:00' }]);
  });
});

test('saving again updates the same row rather than making a second one', { skip }, async () => {
  await inRollback(async (client) => {
    const { tenant, user } = await scaffold(client);
    await syncStylist(client, tenant.id, user, { services: ON('cuts'), hours: [] });
    const first = await stylistRow(client, tenant.id, user.id);

    await syncStylist(client, tenant.id, user, {
      services: ON('styling'),
      hours: [{ weekday: 5, starts: '09:00', ends: '17:00' }],
    });

    const { rows } = await client.query(
      'SELECT id FROM stylists WHERE tenant_id = $1 AND staff_user_id = $2', [tenant.id, user.id],
    );
    assert.equal(rows.length, 1, 'one person, one stylist row');
    assert.equal(rows[0].id, first.id, 'and it is the same row');
    assert.deepEqual(await serviceSlugs(client, first.id), ['zz-blow'],
      'services follow the switches exactly, including what was turned off');
  });
});

test('turning everything off retires them without losing them', { skip }, async () => {
  await inRollback(async (client) => {
    const { tenant, user } = await scaffold(client);
    await syncStylist(client, tenant.id, user, {
      services: ON('cuts'), hours: [{ weekday: 1, starts: '09:00', ends: '17:00' }],
    });
    const before = await stylistRow(client, tenant.id, user.id);

    const result = await syncStylist(client, tenant.id, user, { services: {}, hours: null });

    assert.equal(result, null, 'they no longer take appointments');
    const after = await stylistRow(client, tenant.id, user.id);
    assert.ok(after, 'the row survives, because appointments point at it');
    assert.equal(after.id, before.id);
    assert.equal(after.active, false);
  });
});

test('switching back on revives the same person, not a second one', { skip }, async () => {
  await inRollback(async (client) => {
    const { tenant, user } = await scaffold(client);
    await syncStylist(client, tenant.id, user, { services: ON('cuts'), hours: [] });
    const before = await stylistRow(client, tenant.id, user.id);
    await syncStylist(client, tenant.id, user, { services: {}, hours: null });
    await syncStylist(client, tenant.id, user, { services: ON('cuts'), hours: null });

    const after = await stylistRow(client, tenant.id, user.id);
    assert.equal(after.id, before.id, 'same row');
    assert.equal(after.slug, before.slug, 'and the same booking name, so old links still work');
    assert.equal(after.active, true);
  });
});

test('not sending hours leaves them alone; sending none clears them', { skip }, async () => {
  await inRollback(async (client) => {
    const { tenant, user } = await scaffold(client);
    const week = [{ weekday: 3, starts: '11:00', ends: '19:00' }];
    await syncStylist(client, tenant.id, user, { services: ON('cuts'), hours: week });

    // A save that only renamed them must not wipe the rota.
    await syncStylist(client, tenant.id, user, { services: ON('cuts'), hours: null });
    assert.deepEqual(await hoursFor(client, tenant.id, user.id), week);

    // An empty list is a real answer: they work no fixed hours.
    await syncStylist(client, tenant.id, user, { services: ON('cuts'), hours: [] });
    assert.deepEqual(await hoursFor(client, tenant.id, user.id), []);
  });
});

test('two people cannot take the same booking name', { skip }, async () => {
  await inRollback(async (client) => {
    const { tenant, user } = await scaffold(client);
    const other = (await client.query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, status)
       VALUES ($1, 'zz-roster2@example.com', 'x', 'ZZ Jessi', 'front_desk', 'active')
       RETURNING id, name`,
      [tenant.id],
    )).rows[0];

    await syncStylist(client, tenant.id, user, { services: ON('cuts'), hours: null });
    await syncStylist(client, tenant.id, { ...other, username: 'zz.jessi' },
      { services: ON('cuts'), hours: null });

    const { rows } = await client.query(
      'SELECT slug FROM stylists WHERE tenant_id = $1 ORDER BY slug', [tenant.id],
    );
    assert.deepEqual(rows.map((r) => r.slug), ['zz-jessi', 'zz-jessi-2'],
      'the second one gets a free name instead of colliding');
  });
});

test.after(() => pool().end());
