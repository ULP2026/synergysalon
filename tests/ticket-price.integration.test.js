/**
 * The price typed on the ticket (asked for 2026-11-14): the desk changes
 * what a visit came to, per service on an itemized visit and as the total
 * on an older one, only the people who see the salon's money may, and every
 * change is on the client's Admin activity.
 *
 * Runs in a throwaway ZZ tenant and removes it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';

import { createBooking } from '../api/_lib/booking.js';
import { pool } from '../api/_lib/db.js';
import { setVisitPrice, ticketFor } from '../api/staff/_routes/appointment.js';
import { contactDetail } from '../api/staff/_routes/contacts.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
const TZ = 'America/New_York';
let DAY = DateTime.now().setZone(TZ).plus({ days: 20 }).startOf('day');
while (DAY.weekday !== 3) DAY = DAY.plus({ days: 1 });

const OWNER = { id: null, role: 'owner', name: 'ZZ Owner', email: 'zz-owner@example.com' };
const STYLIST = { id: null, role: 'stylist', name: 'ZZ Stylist', email: 'zz-stylist@example.com' };

const cleanup = () => pool().query("DELETE FROM tenants WHERE slug = 'zz-price'");

async function setup(db) {
  const t = (await db.query(
    "INSERT INTO tenants (slug, name, timezone) VALUES ('zz-price', 'ZZ Price', $1) RETURNING id, slug, name, timezone",
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

const refused = (status, re) => (err) => err.status === status && re.test(err.message);

test('the desk types a visit\'s price, service by service, and it is on the client\'s Admin activity', { skip }, async () => {
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
        start: DAY.set({ hour: 10 }).toISO(), guestName: 'ZZ Price Guest', guestPhone: '8135550111',
        channel: 'staff', minLeadMin: 0,
      });
      await c.query('COMMIT');
    } finally { c.release(); }
    const ref = booked.ref;

    // A stylist does not change what the salon counts.
    await assert.rejects(setVisitPrice(tenant, STYLIST, ref, { prices: [7000, 3500] }), refused(403, /owner, an admin or a manager/));

    // One price per service; the total is their sum.
    let t = await setVisitPrice(tenant, OWNER, ref, { prices: [7000, 3550] });
    assert.deepEqual(t.lines.map((l) => [l.name, l.priceCents, l.durationMin != null]), [['ZZ Cut', 7000, true], ['ZZ Gloss', 3550, true]],
      'prices change, names and minutes stay');
    assert.equal(t.totalCents, 10550);
    assert.equal(t.price, 105.5);

    const detail = await contactDetail(tenant.id, booked.contact_id);
    const ev = detail.activity.find((e) => e.title === 'Appointment price changed');
    assert.ok(ev, 'the change is on the Admin activity');
    assert.equal(ev.detail, 'ZZ Cut $65, ZZ Gloss $30 → ZZ Cut $70, ZZ Gloss $35.50');

    // Some typed and some empty is refused; a bad amount too; nothing changes.
    await assert.rejects(setVisitPrice(tenant, OWNER, ref, { prices: [7000, null] }), refused(400, /every service a price/));
    await assert.rejects(setVisitPrice(tenant, OWNER, ref, { prices: [-100, 3000] }), refused(400, /amount/));
    await assert.rejects(setVisitPrice(tenant, OWNER, ref, { prices: [7000] }), refused(400, /each service/));
    t = await ticketFor(tenant, ref);
    assert.equal(t.totalCents, 10550);

    // All empty clears it.
    t = await setVisitPrice(tenant, { ...OWNER, role: 'manager' }, ref, { prices: [null, ''] });
    assert.equal(t.totalCents, null);
    assert.deepEqual(t.lines.map((l) => l.priceCents), [null, null]);
  } finally {
    await cleanup();
  }
});

test('an older visit with no itemized list takes only its total', { skip }, async () => {
  await cleanup();
  const db = pool();
  try {
    const tenant = await setup(db);
    await db.query(
      `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, starts_at, duration_min, buffer_min,
                                 during, guest_name, guest_phone, manage_token, channel, notes, price_cents)
       SELECT $1, 'ZZPRC2', s.id, v.id, $2::timestamptz, 120, 15,
              tstzrange($2::timestamptz, $2::timestamptz + interval '135 minutes'), 'ZZ Old', '8135550112', 'tok-zzprc2',
              'staff', E'Services: ZZ Cut, ZZ Gloss', 9500
         FROM stylists s, services v WHERE s.tenant_id = $1 AND v.tenant_id = $1 AND v.slug = 'zz-cut'`,
      [tenant.id, DAY.set({ hour: 14 }).toISO()],
    );
    const t = await setVisitPrice(tenant, OWNER, 'ZZPRC2', { total: 12000 });
    assert.equal(t.itemized, false);
    assert.equal(t.totalCents, 12000);
    assert.deepEqual(t.lines.map((l) => l.priceCents), [null, null], 'no split is invented');
  } finally {
    await cleanup();
    await pool().end();
    globalThis.__synergyPool = undefined;
  }
});
