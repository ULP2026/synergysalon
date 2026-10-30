/**
 * The client's Activity names who booked each visit (asked for 2026-10-31):
 * Karen, the team member at the desk by name, or the client on the website.
 *
 * Runs in a throwaway ZZ tenant and removes it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';

import { createBooking } from '../api/_lib/booking.js';
import { pool } from '../api/_lib/db.js';
import { bookedLabel, contactDetail } from '../api/staff/_routes/contacts.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
const TZ = 'America/New_York';
let DAY = DateTime.now().setZone(TZ).plus({ days: 20 }).startOf('day');
while (DAY.weekday !== 3) DAY = DAY.plus({ days: 1 });

test('the label: Karen first, then the team member, then the website', () => {
  assert.equal(bookedLabel({ via: 'karen', channel: 'staff', booked_by: 'ZZ Luis' }), 'Booked by Karen');
  assert.equal(bookedLabel({ via: 'karen', channel: 'online' }), 'Booked by Karen');
  assert.equal(bookedLabel({ channel: 'staff', booked_by: 'ZZ Luis' }), 'Booked by ZZ Luis');
  assert.equal(bookedLabel({ channel: 'staff', booked_by: null }), 'Booked by staff');
  assert.equal(bookedLabel({ channel: 'online' }), 'Booked by Client (Website)');
});

const cleanup = () => pool().query("DELETE FROM tenants WHERE slug = 'zz-who'");

test('each booking on a client\'s Activity says who made it', { skip }, async () => {
  await cleanup();
  const db = pool();
  try {
    const tenant = (await db.query(
      "INSERT INTO tenants (slug, name, timezone) VALUES ('zz-who', 'ZZ Who', $1) RETURNING id, slug, name, timezone", [TZ],
    )).rows[0];
    await db.query(
      `INSERT INTO services (tenant_id, slug, name, category, duration_min, buffer_min)
       VALUES ($1, 'zz-cut', 'ZZ Cut', 'cuts', 60, 15)`, [tenant.id],
    );
    const st = (await db.query(
      `INSERT INTO stylists (tenant_id, slug, name, service_details)
       VALUES ($1, 'zz-dina', 'ZZ Dina', '{"lunch": false}') RETURNING id`, [tenant.id],
    )).rows[0].id;
    await db.query('INSERT INTO stylist_services (stylist_id, service_id) SELECT $1, id FROM services WHERE tenant_id = $2', [st, tenant.id]);
    await db.query("INSERT INTO stylist_hours (stylist_id, weekday, starts_at, ends_at) VALUES ($1, 3, '09:00', '17:00')", [st]);
    const luis = (await db.query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role)
       VALUES ($1, 'zz-who-luis@example.com', 'x', 'ZZ Luis', 'front_desk') RETURNING id`, [tenant.id],
    )).rows[0].id;
    const contact = (await db.query(
      "INSERT INTO contacts (tenant_id, name, email) VALUES ($1, 'ZZ Who Guest', 'zz-who@example.com') RETURNING id", [tenant.id],
    )).rows[0].id;

    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const book = (hour, extra) => createBooking(c, tenant, {
        serviceSlug: 'zz-cut', stylistSlug: 'zz-dina', start: DAY.set({ hour }).toISO(),
        guestName: 'ZZ Who Guest', guestEmail: 'zz-who@example.com', contactId: contact, minLeadMin: 0, ...extra,
      });
      await book(9, { channel: 'staff', bookedBy: luis });             // at the desk
      await book(11, { channel: 'staff', bookedBy: luis, via: 'karen' }); // Karen, asked in the app
      await c.query('COMMIT');
    } finally { c.release(); }
    // The website books online; the survey has no Google here, so it is put in
    // as the website's path writes it.
    await db.query(
      `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, contact_id, starts_at, duration_min, buffer_min,
                                 during, guest_name, guest_email, manage_token, channel)
       SELECT $1, 'ZZWHO3', $2, v.id, $3, $4::timestamptz, 60, 15,
              tstzrange($4::timestamptz, $4::timestamptz + interval '75 minutes'), 'ZZ Who Guest', 'zz-who@example.com',
              'tok-zzwho3', 'online'
         FROM services v WHERE v.tenant_id = $1`,
      [tenant.id, st, contact, DAY.set({ hour: 14 }).toISO()],
    );

    const d = await contactDetail(tenant.id, contact);
    const booked = d.activity.filter((e) => e.type === 'appointment' && e.title.startsWith('Booked by'))
      .map((e) => e.title).sort();
    assert.deepEqual(booked, ['Booked by Client (Website)', 'Booked by Karen', 'Booked by ZZ Luis']);
    assert.ok(d.activity.filter((e) => e.title.startsWith('Booked by')).every((e) => e.tone === 'booked'));
  } finally {
    await cleanup();
    await pool().end();
    globalThis.__synergyPool = undefined;
  }
});
