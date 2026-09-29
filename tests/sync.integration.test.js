/**
 * The CENTRO mirror: what it sends, and that a late job cannot undo a newer
 * change.
 *
 *   DATABASE_URL=postgres://… node --test "tests/*.test.js"
 *
 * Skips without DATABASE_URL. Runs in a throwaway ZZ tenant with a fake
 * token and CENTRO stubbed out, and drains that tenant's queue only, so real
 * jobs in the database it is pointed at are never touched.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';

import { pool } from '../api/_lib/db.js';
import { ghlStatusFor } from '../api/_lib/ghl.js';
import { drain, requeueFailed } from '../api/cron/sync.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';

const START = DateTime.now().plus({ years: 5 }).startOf('day').set({ hour: 14 });

/** Answers like CENTRO, and records what it was asked. */
function stubCentro({ failCreate = false } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (href, init) => {
    const path = new URL(href).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path, body });
    if (path === '/contacts/upsert') return Response.json({ contact: { id: 'zz-contact' } });
    if (path === '/calendars/events/appointments' && init.method === 'POST') {
      if (failCreate) return new Response('{"message":"The calendar is inactive"}', { status: 422 });
      return Response.json({ id: 'zz-event' });
    }
    return Response.json({});
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function setup() {
  const t = (await pool().query(
    `INSERT INTO tenants (slug, name, ghl_location_id, ghl_token, ghl_calendar_id, ghl_user_id)
     VALUES ('zz-sync', 'ZZ Sync', 'zz-loc', 'zz-token', 'zz-cal', 'zz-user') RETURNING id`,
  )).rows[0].id;
  const s = (await pool().query(
    "INSERT INTO stylists (tenant_id, slug, name) VALUES ($1, 'zz', 'ZZ Stylist') RETURNING id", [t],
  )).rows[0].id;
  const v = (await pool().query(
    `INSERT INTO services (tenant_id, slug, name, category, duration_min)
     VALUES ($1, 'zz', 'ZZ Cut', 'cut', 60) RETURNING id`, [t],
  )).rows[0].id;
  const a = (await pool().query(
    `INSERT INTO appointments (
       tenant_id, ref, stylist_id, service_id, starts_at, duration_min, buffer_min, during,
       guest_name, guest_email, manage_token
     ) VALUES ($1, 'ZZSYNC1', $2, $3, $4::timestamptz, 60, 0,
               tstzrange($4::timestamptz, $4::timestamptz + interval '60 minutes', '[)'),
               'ZZ Guest', 'zz-sync@example.com', 'zz-sync-token')
     RETURNING id`,
    [t, s, v, START.toISO()],
  )).rows[0].id;
  return { t, a };
}

const enqueue = (t, a, kind) => pool().query(
  'INSERT INTO sync_outbox (tenant_id, kind, appointment_id) VALUES ($1, $2, $3)', [t, kind, a],
);

async function cleanup() {
  await pool().query("DELETE FROM tenants WHERE slug = 'zz-sync'");
}

test('our statuses become the ones CENTRO shows', () => {
  assert.equal(ghlStatusFor({ status: 'booked' }), 'confirmed');
  assert.equal(ghlStatusFor({ status: 'booked', checked_in_at: new Date() }), 'showed');
  assert.equal(ghlStatusFor({ status: 'completed' }), 'showed');
  assert.equal(ghlStatusFor({ status: 'no_show' }), 'noshow');
  assert.equal(ghlStatusFor({ status: 'cancelled' }), 'cancelled');
});

test('a booking, its check-in and its cancellation each reach CENTRO', { skip }, async () => {
  await cleanup();
  const { t, a } = await setup();
  const stub = stubCentro();
  try {
    await enqueue(t, a, 'appointment.booked');
    await drain(10, { tenantId: t });
    const create = stub.calls.find((c) => c.method === 'POST' && c.path === '/calendars/events/appointments');
    assert.equal(create.body.appointmentStatus, 'confirmed');
    assert.equal(create.body.calendarId, 'zz-cal');
    const { rows } = await pool().query('SELECT ghl_appointment_id FROM appointments WHERE id = $1', [a]);
    assert.equal(rows[0].ghl_appointment_id, 'zz-event');

    await pool().query('UPDATE appointments SET checked_in_at = now() WHERE id = $1', [a]);
    await enqueue(t, a, 'appointment.status');
    await drain(10, { tenantId: t });
    const put = stub.calls.at(-1);
    assert.equal(put.path, '/calendars/events/appointments/zz-event');
    assert.equal(put.body.appointmentStatus, 'showed');

    await pool().query("UPDATE appointments SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [a]);
    await enqueue(t, a, 'appointment.cancelled');
    await drain(10, { tenantId: t });
    assert.equal(stub.calls.at(-1).body.appointmentStatus, 'cancelled');
  } finally {
    stub.restore();
    await cleanup();
  }
});

test('a refused booking retried after it was cancelled is not put on the calendar', { skip }, async () => {
  await cleanup();
  const { t, a } = await setup();
  let stub = stubCentro({ failCreate: true });
  try {
    await enqueue(t, a, 'appointment.booked');
    const [first] = await drain(10, { tenantId: t });
    assert.equal(first.state, 'failed');

    // Cancelled while CENTRO was refusing it, then the link is fixed.
    await pool().query("UPDATE appointments SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [a]);
    stub.restore();
    stub = stubCentro();
    assert.equal(await requeueFailed(t), 1);
    const [again] = await drain(10, { tenantId: t });
    assert.match(again.skipped, /cancelled/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    await cleanup();
  }
});

test('draining one tenant leaves other tenants’ jobs alone', { skip }, async () => {
  await cleanup();
  const { t } = await setup();
  const before = (await pool().query(
    "SELECT count(*)::int AS n FROM sync_outbox WHERE state = 'pending' AND tenant_id <> $1", [t],
  )).rows[0].n;
  const stub = stubCentro();
  try {
    await drain(10, { tenantId: t });
    const after = (await pool().query(
      "SELECT count(*)::int AS n FROM sync_outbox WHERE state = 'pending' AND tenant_id <> $1", [t],
    )).rows[0].n;
    assert.equal(after, before);
  } finally {
    stub.restore();
    await cleanup();
    await pool().end();
    globalThis.__synergyPool = undefined;
  }
});
