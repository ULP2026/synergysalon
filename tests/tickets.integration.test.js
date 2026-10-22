/**
 * Tickets and the client profile, against Postgres: a visit of several
 * services is one ticket with every line priced; the Appt. Book and the
 * client's history reach the same ticket; Choose your stylist lists every
 * stylist record; notes and contact preferences save.
 *
 *   DATABASE_URL=postgres://… node --test "tests/*.test.js"
 *
 * Runs against the seeded tenant (db/seed.sql) with migrations applied
 * (031 included), inside transactions it rolls back. Test rows are named ZZ.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';
import pg from 'pg';

import { createBooking } from '../api/_lib/booking.js';
import { hasColumn } from '../api/_lib/db.js';
import { ticketFor } from '../api/staff/_routes/appointment.js';
import {
  addNote, contactDetail, setPrefs, stylistChoices,
} from '../api/staff/_routes/contacts.js';
import { makeBookable } from './bookable.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const isLocal = url?.includes('localhost') || url?.includes('127.0.0.1');
const connect = async () => {
  const c = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await c.connect();
  return c;
};

/** A Tuesday three to four weeks out: inside the booking horizon, 9 to 3 in the seed. */
function tuesday(zone) {
  let d = DateTime.now().setZone(zone).plus({ days: 21 }).startOf('day');
  while (d.weekday !== 2) d = d.plus({ days: 1 });
  return d;
}

async function setup(c) {
  const { rows } = await c.query("SELECT id, slug, name, timezone FROM tenants WHERE slug = 'synergy'");
  const tenant = rows[0];
  await makeBookable(c, tenant.id, 'dina');
  // The seed prices nothing; these are the test's own, rolled back with it.
  await c.query(
    `UPDATE services SET price_cents = CASE slug WHEN 'haircuts' THEN 6500 ELSE 5500 END
      WHERE tenant_id = $1 AND slug IN ('haircuts', 'blowouts')`,
    [tenant.id],
  );
  // Nothing of Dina's own timing, so each line is the service table's length.
  await c.query("UPDATE stylists SET service_details = '{}'::jsonb WHERE tenant_id = $1 AND slug = 'dina'", [tenant.id]);
  const { rows: ct } = await c.query(
    `INSERT INTO contacts (tenant_id, name, phone, email, source)
     VALUES ($1, 'ZZ Ticket Client', '8135550177', 'zz-ticket@example.com', 'Front desk') RETURNING id`,
    [tenant.id],
  );
  return { tenant, contactId: ct[0].id };
}

test('a visit of several services is one ticket, itemized, the same from the diary and the client', { skip }, async () => {
  const c = await connect();
  try {
    await c.query('BEGIN');
    const { tenant, contactId } = await setup(c);
    const start = tuesday(tenant.timezone).set({ hour: 10 });

    const booked = await createBooking(c, tenant, {
      serviceSlug: 'haircuts', extraServiceSlugs: ['blowouts'], stylistSlug: 'dina',
      start: start.toISO(), guestName: 'ZZ Ticket Client', guestPhone: '8135550177',
      channel: 'staff', minLeadMin: 0, contactId,
    });
    assert.equal(booked.price_cents, 12000);

    // The Appt. Book opens the ticket by its ref.
    const t = await ticketFor(tenant, booked.ref, c);
    assert.equal(t.itemized, true);
    assert.deepEqual(t.lines.map((l) => [l.name, l.priceCents, l.durationMin]), [
      ['Haircut', 6500, 60],
      ['Blowout & Styling', 5500, 45],
    ]);
    assert.equal(t.lines.reduce((sum, l) => sum + l.priceCents, 0), t.totalCents);
    assert.equal(t.service, 'Haircut + Blowout & Styling');
    assert.equal(t.contactId, contactId);
    assert.equal(t.stylistSlug, 'dina');
    assert.equal(t.time, '10:00 AM');
    // Nothing is recorded about payment, and the ticket does not pretend.
    assert.deepEqual(t.payment, { status: 'not_tracked' });
    assert.deepEqual(t.transactions, []);

    // The client's history points at the same ticket, and its events say
    // what kind of thing happened.
    const d = await contactDetail(tenant.id, contactId, c);
    assert.ok(d.appointments.some((a) => a.ref === booked.ref));
    const ev = d.activity.find((e) => e.ref === booked.ref);
    assert.equal(ev.tone, 'booked');
    assert.deepEqual((await ticketFor(tenant, ev.ref, c)).lines, t.lines);
    // Their stylist tag is whoever they booked with.
    assert.equal(d.contact.stylist.slug, 'dina');
    // Checked in: a different colour on the timeline.
    await c.query('UPDATE appointments SET checked_in_at = now() WHERE ref = $1', [booked.ref]);
    const after = await contactDetail(tenant.id, contactId, c);
    assert.ok(after.activity.some((e) => e.ref === booked.ref && e.tone === 'checkin'));
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});

test('a visit booked before itemizing shows its total, not a guessed split', { skip }, async () => {
  const c = await connect();
  try {
    await c.query('BEGIN');
    const { tenant, contactId } = await setup(c);
    const start = tuesday(tenant.timezone).set({ hour: 12 });
    const { rows } = await c.query(
      `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, contact_id, starts_at,
              duration_min, buffer_min, price_cents, during, guest_name, guest_phone, channel, manage_token)
       SELECT $1, 'ZZTKOLD', s.id, v.id, $2, $3, 105, 10, 12000,
              tstzrange($3::timestamptz, $3::timestamptz + make_interval(mins => 115), '[)'),
              'ZZ Ticket Client', '8135550177', 'staff', 'tok-ZZTKOLD'
         FROM stylists s, services v
        WHERE s.tenant_id = $1 AND s.slug = 'dina' AND v.tenant_id = $1 AND v.slug = 'haircuts'
       RETURNING ref`,
      [tenant.id, contactId, start.toISO()],
    );
    const t = await ticketFor(tenant, rows[0].ref, c);
    assert.equal(t.itemized, false);
    assert.deepEqual(t.lines, [{ name: 'Haircut', priceCents: null, durationMin: null }]);
    assert.equal(t.totalCents, 12000);
    assert.equal(await ticketFor(tenant, 'ZZNOSUCH', c), null);
    // What lets a database without migration 031 book as before.
    assert.equal(await hasColumn('appointments', 'services', c), true);
    assert.equal(await hasColumn('appointments', 'zz_not_a_column', c), false);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});

test('Choose your stylist lists every stylist record, and keeps one who has left', { skip }, async () => {
  const c = await connect();
  try {
    await c.query('BEGIN');
    const { tenant, contactId } = await setup(c);
    const add = (slug, active) => c.query(
      `INSERT INTO stylists (tenant_id, slug, name, active, sort_order)
       VALUES ($1, $2, $3, $4, 999) RETURNING id`,
      [tenant.id, slug, `ZZ ${slug}`, active],
    );
    // A chair with no login and no calendar: listed.
    await add('zz-nologin', true);
    // Left the salon, with a client's past visit: listed, marked as left.
    const { rows: gone } = await add('zz-left', false);
    await c.query('UPDATE stylists SET removed_at = now() WHERE id = $1', [gone[0].id]);
    const past = DateTime.now().minus({ years: 2 });
    await c.query(
      `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, contact_id, starts_at,
              duration_min, buffer_min, during, guest_name, guest_phone, channel, manage_token, status)
       SELECT $1, 'ZZTKLEFT', $2, v.id, $3, $4, 60, 0,
              tstzrange($4::timestamptz, $4::timestamptz + make_interval(mins => 60), '[)'),
              'ZZ Ticket Client', '8135550177', 'staff', 'tok-ZZTKLEFT', 'completed'
         FROM services v WHERE v.tenant_id = $1 AND v.slug = 'haircuts'`,
      [tenant.id, gone[0].id, contactId, past.toISO()],
    );
    // Switched off and never booked: a placeholder, not a stylist anyone had.
    await add('zz-never', false);

    const list = await stylistChoices(tenant.id, c);
    const bySlug = new Map(list.map((s) => [s.slug, s]));
    assert.deepEqual(bySlug.get('zz-nologin'), { slug: 'zz-nologin', name: 'ZZ zz-nologin', left: false });
    assert.deepEqual(bySlug.get('zz-left'), { slug: 'zz-left', name: 'ZZ zz-left', left: true });
    assert.equal(bySlug.has('zz-never'), false);
    // Whoever is here comes before whoever has left.
    assert.ok(list.findIndex((s) => s.slug === 'zz-nologin') < list.findIndex((s) => s.slug === 'zz-left'));

    // The client and their history stayed when the stylist left.
    const d = await contactDetail(tenant.id, contactId, c);
    assert.equal(d.appointments[0].ref, 'ZZTKLEFT');
    assert.equal(d.contact.stylist.slug, 'zz-left');
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});

test('notes are added on top and kept; email and texts are separate choices', { skip }, async () => {
  const c = await connect();
  try {
    await c.query('BEGIN');
    const { tenant, contactId } = await setup(c);
    const user = { name: 'ZZ Desk', timezone: tenant.timezone };

    await addNote(tenant.id, user, { id: contactId, note: 'Prefers mornings.' }, c);
    const { notes } = await addNote(tenant.id, user, { id: contactId, note: 'Allergic to ammonia.' }, c);
    const lines = notes.split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^[A-Z][a-z]{2} \d{1,2}, \d{4}, ZZ Desk: Allergic to ammonia\.$/);
    assert.match(lines[1], /ZZ Desk: Prefers mornings\.$/);
    await assert.rejects(addNote(tenant.id, user, { id: contactId, note: '  ' }, c), /Note/);

    // Everyone starts with both on, as before.
    assert.deepEqual((await contactDetail(tenant.id, contactId, c)).contact.prefs, { email: true, sms: true });
    const r = await setPrefs(tenant.id, { id: contactId, email: false, sms: true }, c);
    assert.deepEqual(r.prefs, { email: false, sms: true });
    assert.deepEqual((await contactDetail(tenant.id, contactId, c)).contact.prefs, { email: false, sms: true });
    await assert.rejects(setPrefs(tenant.id, { id: contactId, email: 'no', sms: true }, c), /yes or no/);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});
