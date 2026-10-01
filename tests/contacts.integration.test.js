/**
 * Deleting a contact: what goes, what stays, and what CENTRO is told.
 *
 *   DATABASE_URL=postgres://… node --test "tests/*.test.js"
 *
 * Skips without DATABASE_URL. Everything it creates is named ZZ and removed
 * afterwards, but it runs against whatever database you give it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';
import pg from 'pg';

import { DEFAULT_TZ } from '../api/_lib/config.js';
import { pool } from '../api/_lib/db.js';
import { contactDetail, removeContact } from '../api/staff/_routes/contacts.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';

const isLocal = url?.includes('localhost') || url?.includes('127.0.0.1');
const connect = () => new pg.Client({
  connectionString: url,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

const FUTURE = DateTime.now().setZone(DEFAULT_TZ).plus({ years: 5 }).startOf('day').set({ hour: 14 });
const PAST = DateTime.now().setZone(DEFAULT_TZ).minus({ years: 5 }).startOf('day').set({ hour: 14 });

async function tenantId(client) {
  const { rows } = await client.query("SELECT id FROM tenants WHERE slug = 'synergy'");
  return rows[0].id;
}

async function addContact(client, tenant, { ghl = null } = {}) {
  const { rows } = await client.query(
    `INSERT INTO contacts (tenant_id, name, email, ghl_contact_id)
     VALUES ($1, 'ZZ Delete Me', 'zz-delete@example.com', $2) RETURNING id`,
    [tenant, ghl],
  );
  return rows[0].id;
}

function addAppointment(client, contactId, { ref, start, status = 'booked', ghl = null }) {
  return client.query(
    `INSERT INTO appointments (
       tenant_id, ref, stylist_id, service_id, contact_id, starts_at, duration_min,
       buffer_min, during, guest_name, guest_email, manage_token, status, ghl_appointment_id
     )
     SELECT t.id, $1, s.id, v.id, $2, $3, 60, 0,
            tstzrange($3::timestamptz, $3::timestamptz + make_interval(mins => 60), '[)'),
            'ZZ Delete Me', 'zz-delete@example.com', $4, $5::appointment_status, $6
       FROM tenants t
       JOIN stylists s ON s.tenant_id = t.id AND s.slug = 'dina'
       JOIN services v ON v.tenant_id = t.id AND v.slug = 'haircuts'
      WHERE t.slug = 'synergy'
     RETURNING id`,
    [ref, contactId, start.toISO(), `tok-${ref}`, status, ghl],
  );
}

async function cleanup(client) {
  await client.query("DELETE FROM appointments WHERE ref LIKE 'ZZDEL%'");
  await client.query("DELETE FROM contacts WHERE name = 'ZZ Delete Me'");
  await client.query(
    "DELETE FROM sync_outbox WHERE kind = 'contact.deleted' AND payload->>'name' = 'ZZ Delete Me'",
  );
}

async function inTransaction(client, fn) {
  await client.query('BEGIN');
  try {
    const out = await fn();
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

test('deleting a contact frees their future slots and keeps their history', { skip }, async () => {
  const client = connect();
  await client.connect();
  try {
    await cleanup(client);
    const tenant = await tenantId(client);
    const id = await addContact(client, tenant, { ghl: 'ghl-zz-contact' });
    const { rows: [future] } = await addAppointment(client, id, {
      ref: 'ZZDELA', start: FUTURE, ghl: 'ghl-zz-event',
    });
    const { rows: [past] } = await addAppointment(client, id, {
      ref: 'ZZDELB', start: PAST, status: 'completed',
    });
    // An unsent push would recreate them in CENTRO the next time the queue ran.
    await client.query(
      `INSERT INTO sync_outbox (tenant_id, kind, contact_id) VALUES ($1, 'contact.updated', $2)`,
      [tenant, id],
    );

    const removed = await inTransaction(client, () => removeContact(client, tenant, id));
    assert.deepEqual(removed, { name: 'ZZ Delete Me', cancelled: 1, inCentro: true });

    const { rows: gone } = await client.query('SELECT 1 FROM contacts WHERE id = $1', [id]);
    assert.equal(gone.length, 0);

    const { rows: appts } = await client.query(
      'SELECT id, status, contact_id, guest_name FROM appointments WHERE id = ANY($1)',
      [[future.id, past.id]],
    );
    const byId = Object.fromEntries(appts.map((a) => [a.id, a]));
    assert.equal(byId[future.id].status, 'cancelled');
    assert.equal(byId[past.id].status, 'completed');
    assert.equal(byId[past.id].contact_id, null);
    assert.equal(byId[past.id].guest_name, 'ZZ Delete Me');

    // The slot is sellable again.
    await addAppointment(client, null, { ref: 'ZZDELC', start: FUTURE });

    const { rows: jobs } = await client.query(
      `SELECT kind, contact_id, payload FROM sync_outbox
        WHERE state = 'pending'
          AND (contact_id = $1 OR payload->>'name' = 'ZZ Delete Me')`,
      [id],
    );
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].kind, 'contact.deleted');
    assert.equal(jobs[0].contact_id, null);
    assert.deepEqual(jobs[0].payload, {
      ghlContactId: 'ghl-zz-contact', ghlAppointmentIds: ['ghl-zz-event'], name: 'ZZ Delete Me',
    });
  } finally {
    await cleanup(client).catch(() => {});
    await client.end();
  }
});

test('a contact who never reached CENTRO queues nothing for it', { skip }, async () => {
  const client = connect();
  await client.connect();
  try {
    await cleanup(client);
    const tenant = await tenantId(client);
    const id = await addContact(client, tenant);

    const removed = await inTransaction(client, () => removeContact(client, tenant, id));
    assert.equal(removed.inCentro, false);

    const { rows } = await client.query(
      "SELECT 1 FROM sync_outbox WHERE payload->>'name' = 'ZZ Delete Me'",
    );
    assert.equal(rows.length, 0);
  } finally {
    await cleanup(client).catch(() => {});
    await client.end();
  }
});

test('an unknown contact is reported, not silently accepted', { skip }, async () => {
  const client = connect();
  await client.connect();
  try {
    const tenant = await tenantId(client);
    const removed = await inTransaction(client, () => removeContact(
      client, tenant, '00000000-0000-0000-0000-000000000000',
    ));
    assert.equal(removed, null);
  } finally {
    await client.end();
  }
});

test('a contact\'s detail shows what really happened, newest first, and nothing else', { skip }, async () => {
  const client = connect();
  await client.connect();
  try {
    await cleanup(client);
    const tenant = await tenantId(client);
    const id = await addContact(client, tenant);
    // Came in through the website wizard, which is what a session id means.
    await client.query("UPDATE contacts SET session_id = 'zz-session', source = 'Instagram' WHERE id = $1", [id]);
    await addAppointment(client, id, { ref: 'ZZDELD', start: PAST, status: 'completed' });
    await client.query("UPDATE appointments SET reminder_sent_at = $1::timestamptz WHERE ref = 'ZZDELD'",
                       [PAST.minus({ days: 1 }).toISO()]);
    await addAppointment(client, id, { ref: 'ZZDELE', start: FUTURE });
    await client.query(
      `INSERT INTO sync_outbox (tenant_id, kind, contact_id, state, done_at)
       VALUES ($1, 'contact.created', $2, 'done', now())`,
      [tenant, id],
    );

    const d = await contactDetail(tenant, id);
    assert.equal(d.contact.name, 'ZZ Delete Me');
    assert.deepEqual(d.appointments.map((a) => a.ref), ['ZZDELE', 'ZZDELD']);

    const titles = d.activity.map((e) => e.title);
    assert.ok(titles.includes('Filled in the website booking form'));
    assert.ok(titles.includes('Reminder email sent'));
    assert.ok(titles.includes('Marked as done'));
    assert.ok(titles.includes('Synced to the CRM'));
    assert.equal(titles.filter((t) => t === 'Booked by staff' || t === 'Booked online').length, 2);
    // No messaging history exists yet, so none is shown.
    assert.ok(!d.activity.some((e) => e.type === 'sms' || e.type === 'automation'));
    const times = d.activity.map((e) => new Date(e.at).getTime());
    assert.deepEqual(times, [...times].sort((x, y) => y - x));

    assert.equal(await contactDetail(tenant, '00000000-0000-0000-0000-000000000000'), null);
  } finally {
    await cleanup(client).catch(() => {});
    await client.end();
    await pool().end().catch(() => {});
    globalThis.__synergyPool = undefined;
  }
});
