/**
 * Everyone who books becomes a client of the salon.
 *
 *   DATABASE_URL=postgres://… npm test
 *
 * Skips without a database. Runs inside a transaction it rolls back, so the
 * fixture never outlives the test; rows are named ZZ all the same.
 *
 * What this is here for: a booking used to carry the guest's name, email and
 * phone on the appointment and nothing else. The diary showed them, so it
 * looked right, and the Clients screen -- which reads the contacts table --
 * had never heard of them. So did the welcome, rebook, second-visit and
 * win-back emails, every one of which selects on contact_id.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';
import pg from 'pg';

import { createBooking } from '../api/_lib/booking.js';
import { makeBookable } from './bookable.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const isLocal = url?.includes('localhost') || url?.includes('127.0.0.1');

async function connect() {
  const c = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await c.connect();
  return c;
}

/**
 * A Tuesday five weeks out, and Tami rather than Dina.
 *
 * Both on purpose. Test files run concurrently, each inside its own open
 * transaction, and an uncommitted appointment is still enough for the
 * exclusion constraint to refuse the next one. Two other files book Dina on
 * the Tuesday three weeks out, so sharing it bought a failure that had
 * nothing to do with what is being tested here.
 */
function tuesday(zone) {
  let d = DateTime.now().setZone(zone).plus({ days: 35 }).startOf('day');
  while (d.weekday !== 2) d = d.plus({ days: 1 });
  return d;
}

const book = (c, tenant, start, who) => createBooking(c, tenant, {
  serviceSlug: 'haircuts', stylistSlug: 'tami', start: start.toISO(),
  channel: 'online', minLeadMin: 0, ...who,
});

const contactOf = async (c, id) => (await c.query(
  `SELECT name, email, phone, source, status, first_booked_at
     FROM contacts WHERE id = $1`, [id],
)).rows[0];

test('a guest who books is a client, and books again as the same one', { skip }, async () => {
  const c = await connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query("SELECT id, slug, name, timezone FROM tenants WHERE slug = 'synergy'");
    const tenant = rows[0];
    await makeBookable(c, tenant.id, 'tami');
    const day = tuesday(tenant.timezone);
    // A haircut is 60 minutes with 10 to turn the station round, so these
    // are spaced to clear it. An appointment that will not fit proves
    // nothing about whether a guest became a client.
    const at = (h, m = 0) => day.set({ hour: h, minute: m });

    const first = await book(c, tenant, at(10), {
      guestName: 'ZZ Lead', guestEmail: 'zz-lead@example.com', guestPhone: '8135550123',
    });

    // The appointment knows who it is for.
    assert.ok(first.contact_id, 'the booking made a client record');
    const made = await contactOf(c, first.contact_id);
    assert.equal(made.name, 'ZZ Lead');
    assert.equal(made.email, 'zz-lead@example.com');
    assert.equal(made.status, 'booked');
    assert.equal(made.source, 'Online booking');
    assert.ok(made.first_booked_at, 'and the date the salon first took one from them');

    // And the Clients screen can see them: this is the query behind the list.
    const { rows: listed } = await c.query(
      `SELECT c.id FROM contacts c WHERE c.tenant_id = $1
        AND EXISTS (SELECT 1 FROM appointments a WHERE a.contact_id = c.id)`,
      [tenant.id],
    );
    assert.ok(listed.some((r) => r.id === first.contact_id), 'they appear in Clients');

    // Booking again is the same person, not a second one. This is the whole
    // reason to match rather than insert: a salon with every guest twice is
    // worse than one with none of them.
    const again = await book(c, tenant, at(11, 30), {
      guestName: 'ZZ Lead', guestEmail: 'ZZ-Lead@Example.com', guestPhone: '',
    });
    assert.equal(again.contact_id, first.contact_id, 'matched on the address, whatever its case');

    // The phone alone finds them too: the front desk often has only one.
    const third = await book(c, tenant, at(13), {
      guestName: 'ZZ Lead', guestEmail: '', guestPhone: '8135550123', channel: 'staff',
    });
    assert.equal(third.contact_id, first.contact_id, 'matched on the number');

    const { rows: count } = await c.query(
      "SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1 AND name = 'ZZ Lead'",
      [tenant.id],
    );
    assert.equal(count[0].n, 1, 'three bookings, one client');

    // A client of the salon, and of nobody else's system.
    const { rows: queued } = await c.query(
      `SELECT 1 FROM sync_outbox
        WHERE contact_id = $1 OR appointment_id = ANY($2::uuid[])`,
      [first.contact_id, [first.id, again.id, third.id]],
    );
    assert.equal(queued.length, 0, 'nothing about them is queued for CENTRO');
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});

test('an enquiry who books keeps the record they already had', { skip }, async () => {
  const c = await connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query("SELECT id, slug, name, timezone FROM tenants WHERE slug = 'synergy'");
    const tenant = rows[0];
    await makeBookable(c, tenant.id, 'tami');
    const day = tuesday(tenant.timezone);

    const { rows: made } = await c.query(
      `INSERT INTO contacts (tenant_id, name, email, source, status, notes)
       VALUES ($1, 'ZZ Enquiry', 'zz-enquiry@example.com', 'Facebook ad', 'new', 'asked about balayage')
       RETURNING id`,
      [tenant.id],
    );

    const appt = await book(c, tenant, day.set({ hour: 11 }), {
      guestName: 'ZZ Enquiry', guestEmail: 'zz-enquiry@example.com',
    });
    assert.equal(appt.contact_id, made[0].id, 'the enquiry and the booking are one person');

    const contact = await contactOf(c, made[0].id);
    assert.equal(contact.status, 'booked', 'a new enquiry who books has booked');
    // Where they came from is not overwritten by how they booked: the salon
    // paid for that answer.
    assert.equal(contact.source, 'Facebook ad');
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});
