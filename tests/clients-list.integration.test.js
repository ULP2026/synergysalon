/**
 * Clients' Filters and Sort (asked for 2026-11-06), through the real
 * /api/staff/contacts handler as the owner, and the next visit being the
 * soonest one ahead (it was the latest until then).
 *
 * Three ZZ clients, found by searching "ZZ List" so the salon's own clients
 * never enter into it; removed afterwards.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';

import { createSession } from '../api/_lib/auth.js';
import { DEFAULT_TZ } from '../api/_lib/config.js';
import { pool } from '../api/_lib/db.js';
import { ensureSchema } from '../api/_lib/ensure-schema.js';
import contacts from '../api/staff/_routes/contacts.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

function list(cookie, params) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }); },
    };
    const qs = new URLSearchParams({ q: 'ZZ List', ...params });
    contacts({ method: 'GET', url: `/api/staff/contacts?${qs}`, headers: { cookie, host: 'localhost' } }, res);
  });
}
const names = (r) => r.body.contacts.map((c) => c.name.replace('ZZ List ', ''));

async function cleanup(db) {
  await db.query("DELETE FROM appointments WHERE ref LIKE 'ZZLS%'");
  await db.query("DELETE FROM contacts WHERE name LIKE 'ZZ List %'");
  await db.query("DELETE FROM staff_sessions WHERE user_id IN (SELECT id FROM staff_users WHERE email = 'zz-list-owner@example.com')");
  await db.query("DELETE FROM staff_users WHERE email = 'zz-list-owner@example.com'");
}

test('Clients: every filter and sort, and the next visit is the soonest', { skip }, async () => {
  await ensureSchema();
  const db = pool();
  await cleanup(db);
  try {
    const { rows: [t] } = await db.query("SELECT id FROM tenants WHERE slug = 'synergy'");
    const owner = (await db.query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, onboarded_at)
       VALUES ($1, 'zz-list-owner@example.com', 'x', 'ZZ List Owner', 'owner', now()) RETURNING *`, [t.id],
    )).rows[0];
    const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } };
    await createSession(res, owner);
    const cookie = String(res.headers['set-cookie']).split(';')[0];

    const add = async (name, status, extra = '') => (await db.query(
      `INSERT INTO contacts (tenant_id, name, phone, status ${extra ? ', card_on_file, tags' : ''})
       VALUES ($1, $2, '8135550111', $3::contact_status ${extra ? ', true, ARRAY[\'ZZvip\']' : ''}) RETURNING id`,
      [t.id, name, status],
    )).rows[0].id;
    const alpha = await add('ZZ List Alpha', 'new', 'card');
    await add('ZZ List Bravo', 'booked');
    const charlie = await add('ZZ List Charlie', 'won');
    const now = DateTime.now().setZone(DEFAULT_TZ).startOf('hour');
    const visit = (ref, contactId, start, status = 'booked') => db.query(
      `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, contact_id, starts_at, duration_min,
                                 buffer_min, during, guest_name, guest_phone, manage_token, status, channel)
       SELECT t.id, $1, s.id, v.id, $2, $3::timestamptz, 60, 0,
              tstzrange($3::timestamptz, $3::timestamptz + interval '60 minutes', '[)'),
              'ZZ List', '8135550111', $4, $5::appointment_status, 'staff'
         FROM tenants t
         JOIN LATERAL (SELECT id FROM stylists WHERE tenant_id = t.id ORDER BY active DESC, slug LIMIT 1) s ON true
         JOIN services v ON v.tenant_id = t.id AND v.slug = 'womens-cut'
        WHERE t.slug = 'synergy'`,
      [ref, contactId, start.toISO(), `tok-${ref}`, status],
    );
    // Alpha: two ahead, years out so nothing real is in the way. Charlie: one past.
    await visit('ZZLS1', alpha, now.plus({ years: 6, days: 3 }));
    await visit('ZZLS2', alpha, now.plus({ years: 6, days: 10 }));
    await visit('ZZLS3', charlie, now.minus({ years: 6 }), 'completed');

    let r = await list(cookie, { sort: 'name', stylists: '1' });
    assert.equal(r.status, 200);
    assert.deepEqual(names(r), ['Alpha', 'Bravo', 'Charlie']);
    assert.ok(r.body.tags.includes('ZZvip'), 'the tags in use come with the list');
    const a = r.body.contacts.find((c) => c.name === 'ZZ List Alpha');
    assert.equal(new Date(a.nextVisit).getTime(), now.plus({ years: 6, days: 3 }).toMillis(), 'the next visit is the soonest');
    assert.equal(a.visits, 2);

    assert.deepEqual(names(await list(cookie, { sort: 'name_desc' })), ['Charlie', 'Bravo', 'Alpha']);
    assert.deepEqual(names(await list(cookie, { sort: 'next' })).slice(0, 1), ['Alpha'], 'a client with a visit ahead comes first');
    assert.deepEqual(names(await list(cookie, { sort: 'last' })).slice(0, 1), ['Charlie'], 'the most recent visit first');
    assert.deepEqual(names(await list(cookie, { sort: 'visits' })).slice(0, 1), ['Alpha']);
    assert.deepEqual(names(await list(cookie, { sort: 'nonsense' })).sort(), ['Alpha', 'Bravo', 'Charlie'], 'an unknown sort falls back');

    assert.deepEqual(names(await list(cookie, { next: 'booked' })), ['Alpha']);
    assert.deepEqual(names(await list(cookie, { next: 'none', sort: 'name' })), ['Bravo', 'Charlie']);
    assert.deepEqual(names(await list(cookie, { card: '1' })), ['Alpha']);
    assert.deepEqual(names(await list(cookie, { tag: 'ZZvip' })), ['Alpha']);
    assert.deepEqual(names(await list(cookie, { status: 'won' })), ['Charlie']);
    assert.deepEqual(names(await list(cookie, { status: 'won', next: 'booked' })), [], 'filters combine');
  } finally {
    await cleanup(db);
  }
});
