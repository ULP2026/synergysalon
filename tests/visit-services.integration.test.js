/**
 * Every service of a visit, everywhere (asked for 2026-10-31): a booking of
 * a cut and a gloss reads as both on its ticket, in the client's activity,
 * on Appt. Book and in what its emails are built from, not as the cut.
 *
 * Runs in a throwaway ZZ tenant and removes it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';

import { createBooking } from '../api/_lib/booking.js';
import { CLIENT_PRICES } from '../api/_lib/config.js';
import { pool } from '../api/_lib/db.js';
import { previewMessage } from '../api/_lib/email.js';
import { visitLinesSql, visitNameSql } from '../api/_lib/visit.js';
import { ticketFor } from '../api/staff/_routes/appointment.js';
import { contactDetail } from '../api/staff/_routes/contacts.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
const TZ = 'America/New_York';
let DAY = DateTime.now().setZone(TZ).plus({ days: 20 }).startOf('day');
while (DAY.weekday !== 3) DAY = DAY.plus({ days: 1 });

const cleanup = () => pool().query("DELETE FROM tenants WHERE slug = 'zz-visit'");

async function setup(db) {
  const t = (await db.query(
    "INSERT INTO tenants (slug, name, timezone) VALUES ('zz-visit', 'ZZ Visit', $1) RETURNING id, slug, name, timezone",
    [TZ],
  )).rows[0];
  for (const [slug, name, cat, min, cents] of [
    ['zz-cut', 'ZZ Cut', 'cuts', 60, 6500], ['zz-gloss', 'ZZ Gloss', 'treatments', 45, 3000]]) {
    await db.query(
      `INSERT INTO services (tenant_id, slug, name, category, duration_min, buffer_min, price_cents)
       VALUES ($1, $2, $3, $4, $5, 15, $6)`, [t.id, slug, name, cat, min, cents],
    );
  }
  const st = (await db.query(
    `INSERT INTO stylists (tenant_id, slug, name, service_details)
     VALUES ($1, 'zz-dina', 'ZZ Dina', '{"lunch": false}') RETURNING id`, [t.id],
  )).rows[0].id;
  await db.query(
    'INSERT INTO stylist_services (stylist_id, service_id) SELECT $1, id FROM services WHERE tenant_id = $2',
    [st, t.id],
  );
  await db.query("INSERT INTO stylist_hours (stylist_id, weekday, starts_at, ends_at) VALUES ($1, 3, '09:00', '17:00')", [st]);
  return t;
}

test('a visit of two services shows both on its ticket, activity, diary and emails', { skip }, async () => {
  await cleanup();
  const db = pool();
  try {
    const tenant = await setup(db);
    const c = await db.connect();
    let booked;
    try {
      await c.query('BEGIN');
      booked = await createBooking(c, tenant, {
        serviceSlug: 'zz-cut', extraServiceSlugs: ['zz-gloss'], stylistSlug: 'zz-dina',
        start: DAY.set({ hour: 10 }).toISO(), guestName: 'ZZ Visit Guest', guestPhone: '8135550101',
        channel: 'staff', minLeadMin: 0,
      });
      await c.query('COMMIT');
    } finally { c.release(); }

    // What the confirmation is sent from, straight after booking.
    assert.equal(booked.service_name, 'ZZ Cut + ZZ Gloss');
    assert.deepEqual(booked.lines.map((l) => [l.name, l.priceCents]), [['ZZ Cut', 6500], ['ZZ Gloss', 3000]]);
    const mail = previewMessage('confirmation', { ...booked, guest_email: 'zz@example.com' }, tenant);
    // Every service; prices only once the salon shows clients them.
    assert.match(mail.text, CLIENT_PRICES ? /Services: ZZ Cut · \$65\.00\nZZ Gloss · \$30\.00/ : /Services: ZZ Cut\nZZ Gloss/);

    // The ticket: two lines, each priced, the total.
    const ticket = await ticketFor(tenant, booked.ref);
    assert.equal(ticket.itemized, true);
    assert.equal(ticket.service, 'ZZ Cut + ZZ Gloss');
    assert.deepEqual(ticket.lines.map((l) => [l.name, l.priceCents]), [['ZZ Cut', 6500], ['ZZ Gloss', 3000]]);
    assert.equal(ticket.totalCents, 9500);

    // The client's activity and appointment list.
    const detail = await contactDetail(tenant.id, booked.contact_id);
    const bookedEvent = detail.activity.find((e) => e.title === 'Booked by staff');
    assert.equal(bookedEvent.detail, 'ZZ Cut + ZZ Gloss with ZZ Dina');
    assert.equal(detail.appointments[0].service, 'ZZ Cut + ZZ Gloss');

    // What the reminder, follow-up and Appt. Book queries read.
    const { rows } = await db.query(
      `SELECT ${visitNameSql()} AS service_name, ${visitLinesSql()} AS lines
         FROM appointments a JOIN services v ON v.id = a.service_id WHERE a.ref = $1`, [booked.ref],
    );
    assert.equal(rows[0].service_name, 'ZZ Cut + ZZ Gloss');
    assert.equal(rows[0].lines.length, 2);
  } finally {
    await cleanup();
  }
});

test('an older visit with no itemized list is named from the website\'s record, never guessed', { skip }, async () => {
  await cleanup();
  const db = pool();
  try {
    const tenant = await setup(db);
    // Booked before 031: no services column value, the guest's list in the notes.
    await db.query(
      `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, starts_at, duration_min, buffer_min,
                                 during, guest_name, guest_phone, manage_token, channel, notes, price_cents)
       SELECT $1, 'ZZVIS2', s.id, v.id, $2::timestamptz, 120, 15,
              tstzrange($2::timestamptz, $2::timestamptz + interval '135 minutes'), 'ZZ Old', '8135550102', 'tok-zzvis2',
              'staff', E'Services: ZZ Cut, ZZ Gloss\\nAppointment for: Myself', 9500
         FROM stylists s, services v WHERE s.tenant_id = $1 AND v.tenant_id = $1 AND v.slug = 'zz-cut'`,
      [tenant.id, DAY.set({ hour: 14 }).toISO()],
    );
    const ticket = await ticketFor(tenant, 'ZZVIS2');
    assert.equal(ticket.service, 'ZZ Cut + ZZ Gloss');
    assert.equal(ticket.itemized, false);
    assert.deepEqual(ticket.lines.map((l) => [l.name, l.priceCents]), [['ZZ Cut', null], ['ZZ Gloss', null]],
      'named, but no split of the total is invented');
    assert.equal(ticket.totalCents, 9500);
  } finally {
    await cleanup();
    await pool().end();
    globalThis.__synergyPool = undefined;
  }
});
