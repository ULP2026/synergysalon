/**
 * Marketing, Finance: what visits were worth, by stylist (finance() in
 * api/staff/_routes/business.js), and the Email history module's filters.
 *
 *   TEST_DATABASE_URL=postgres://… npm test
 *
 * finance() and history() read through the shared pool, which only sees
 * committed rows, so this commits -- into a ZZ salon of its own, removed in
 * the finally. Nothing of the salon's is read, and the sums are exact.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { finance, history } from '../api/staff/_routes/business.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const isLocal = url?.includes('localhost') || url?.includes('127.0.0.1');

async function salon(c) {
  const stamp = Date.now();
  const { rows: [t] } = await c.query(
    `INSERT INTO tenants (slug, name, timezone) VALUES ($1, 'ZZ Finance Salon', 'America/New_York') RETURNING id, timezone`,
    [`zz-fin-${stamp}`],
  );
  const stylist = async (slug, name) => (await c.query(
    'INSERT INTO stylists (tenant_id, slug, name) VALUES ($1, $2, $3) RETURNING id', [t.id, slug, name])).rows[0].id;
  const service = async (slug, cents) => (await c.query(
    `INSERT INTO services (tenant_id, slug, name, category, duration_min, price_cents)
     VALUES ($1, $2, $2, 'cuts', 60, $3) RETURNING id`, [t.id, slug, cents])).rows[0].id;
  return { t, stylist, service };
}

let n = 0;
async function visit(c, tenantId, stylistId, serviceId, startsAt, { status = 'booked', cents = null } = {}) {
  n += 1;
  await c.query(
    `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, starts_at, duration_min, buffer_min,
                               during, guest_name, guest_phone, manage_token, status, channel, price_cents)
     VALUES ($1, $2, $3, $4, $5::timestamptz, 60, 0,
             tstzrange($5::timestamptz, $5::timestamptz + interval '60 minutes', '[)'),
             'ZZ Guest', '8135550100', $6, $7::appointment_status, 'staff', $8)`,
    [tenantId, `ZZFN${Date.now() % 100000}${n}`, stylistId, serviceId, startsAt, `zz-fin-${Date.now()}-${n}`, status, cents],
  );
}

test('Finance: earned, booked ahead and unpriced, by stylist, cancelled and no-shows left out', { skip }, async () => {
  const c = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await c.connect();
  let tenantId = null;
  try {
    const { t, stylist, service } = await salon(c);
    tenantId = t.id;
    const ana = await stylist('zz-ana', 'ZZ Ana');
    const bea = await stylist('zz-bea', 'ZZ Bea');
    const cut = await service('zz-cut', 6000);        // $60 on the menu
    const free = await service('zz-consult', null);   // no price anywhere

    // "Now" is pinned so past and future do not depend on when this runs.
    const now = new Date('2026-10-15T16:00:00Z');
    // Ana: two past visits -- one at the menu price, one booked at $80 --
    // one past no-show and one cancelled (neither counts), one ahead.
    await visit(c, t.id, ana, cut, '2026-10-03T14:00:00Z');
    await visit(c, t.id, ana, cut, '2026-10-05T14:00:00Z', { cents: 8000 });
    await visit(c, t.id, ana, cut, '2026-10-06T14:00:00Z', { status: 'no_show' });
    await visit(c, t.id, ana, cut, '2026-10-07T14:00:00Z', { status: 'cancelled' });
    await visit(c, t.id, ana, cut, '2026-10-20T14:00:00Z');
    // Bea: one completed visit with no price at all, and one in September,
    // outside the period.
    await visit(c, t.id, bea, free, '2026-10-08T14:00:00Z', { status: 'completed' });
    await visit(c, t.id, bea, cut, '2026-09-20T14:00:00Z');
    // And one ahead with no price: counted, named, worth $0, never guessed.
    await visit(c, t.id, bea, free, '2026-10-25T14:00:00Z');

    const f = await finance({ id: t.id, timezone: t.timezone }, '2026-10-01', '2026-10-31', now);
    assert.equal(f.from, '2026-10-01');
    assert.equal(f.to, '2026-10-31');
    assert.deepEqual(f.total, { visits: 3, earnedCents: 14000, unpriced: 1, aheadVisits: 2, aheadCents: 6000, aheadUnpriced: 1 });
    assert.deepEqual(f.stylists, [
      { name: 'ZZ Ana', visits: 2, earnedCents: 14000, unpriced: 0, aheadVisits: 1, aheadCents: 6000, aheadUnpriced: 0 },
      { name: 'ZZ Bea', visits: 1, earnedCents: 0, unpriced: 1, aheadVisits: 1, aheadCents: 0, aheadUnpriced: 1 },
    ]);

    // No dates: this month on the salon's clock.
    const d = await finance({ id: t.id, timezone: t.timezone }, null, null, now);
    assert.equal(d.from, '2026-10-01');
    assert.equal(d.to, '2026-10-31');

    // A backwards or over-long period is refused, not guessed at.
    await assert.rejects(finance({ id: t.id, timezone: t.timezone }, '2026-10-31', '2026-10-01', now), (e) => e.status === 400);
    await assert.rejects(finance({ id: t.id, timezone: t.timezone }, '2024-01-01', '2026-10-01', now), (e) => e.status === 400);
  } finally {
    if (tenantId) {
      await c.query('DELETE FROM appointments WHERE tenant_id = $1', [tenantId]);
      await c.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
    await c.end();
  }
});

test('Email history: filtered by message and searched by name or address', { skip }, async () => {
  const c = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await c.connect();
  let tenantId = null;
  try {
    const { rows: [t] } = await c.query(
      `INSERT INTO tenants (slug, name) VALUES ($1, 'ZZ History Filter Salon') RETURNING id`, [`zz-hf-${Date.now()}`]);
    tenantId = t.id;
    await c.query(
      `INSERT INTO message_sends (tenant_id, kind, to_name, to_email) VALUES
         ($1, 'confirmation', 'ZZ Ana Reyes', 'ana@example.com'),
         ($1, 'reminder',     'ZZ Ana Reyes', 'ana@example.com'),
         ($1, 'confirmation', 'ZZ Bea Cruz',  'bea@example.com'),
         ($1, 'confirmation', 'ZZ 100% Done', 'pct@example.com')`,
      [t.id],
    );
    const names = async (opts) => (await history({ id: t.id }, null, opts)).sends.map((s) => `${s.kind}:${s.email}`).sort();

    assert.equal((await names({})).length, 4);
    assert.deepEqual(await names({ kind: 'reminder' }), ['reminder:ana@example.com']);
    assert.deepEqual(await names({ q: 'bea' }), ['confirmation:bea@example.com']);
    assert.deepEqual(await names({ q: 'ANA', kind: 'confirmation' }), ['confirmation:ana@example.com']);
    // A % in the search is a percent sign, not "anything".
    assert.deepEqual(await names({ q: '100%' }), ['confirmation:pct@example.com']);
    assert.deepEqual(await names({ q: 'nobody' }), []);
  } finally {
    if (tenantId) await c.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    await c.end();
  }
});
