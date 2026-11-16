/**
 * Changing the services on a ticket (2026-11-16, ClickUp 1k58pwrcvmy items 2
 * and 3): a service added to a booked visit lengthens it and holds that time
 * on the book; one that would run into the next client is refused with
 * nothing changed; a price typed on the ticket stays with its service; every
 * change is on the client's Admin activity. And two Color services go on one
 * visit, end to end, rather than the second replacing the first.
 *
 * Runs in a throwaway ZZ tenant and removes it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';

import { createBooking } from '../api/_lib/booking.js';
import { pool } from '../api/_lib/db.js';
import {
  applyAppointmentAction, setVisitPrice, setVisitServices, ticketFor,
} from '../api/staff/_routes/appointment.js';
import { contactDetail } from '../api/staff/_routes/contacts.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
const TZ = 'America/New_York';
let DAY = DateTime.now().setZone(TZ).plus({ days: 20 }).startOf('day');
while (DAY.weekday !== 3) DAY = DAY.plus({ days: 1 });

const OWNER = { id: null, role: 'owner', name: 'ZZ Owner', email: 'zz-owner@example.com' };

const cleanup = () => pool().query("DELETE FROM tenants WHERE slug = 'zz-tsvc'");

async function setup(db) {
  const t = (await db.query(
    "INSERT INTO tenants (slug, name, timezone) VALUES ('zz-tsvc', 'ZZ Ticket Services', $1) RETURNING id, slug, name, timezone",
    [TZ],
  )).rows[0];
  for (const [slug, name, cat, min, cents] of [
    ['zz-cut', 'ZZ Cut', 'cuts', 60, 6500], ['zz-gloss', 'ZZ Gloss', 'treatments', 45, 3000],
    ['zz-single', 'ZZ Single Process', 'color', 90, null], ['zz-partial', 'ZZ Partial Highlights', 'color', 120, null]]) {
    await db.query(
      `INSERT INTO services (tenant_id, slug, name, category, duration_min, buffer_min, price_cents)
       VALUES ($1, $2, $3, $4, $5, 0, $6)`, [t.id, slug, name, cat, min, cents],
    );
  }
  const mk = async (slug, name, only) => {
    const id = (await db.query(
      `INSERT INTO stylists (tenant_id, slug, name, service_details)
       VALUES ($1, $2, $3, '{"lunch": false}') RETURNING id`, [t.id, slug, name],
    )).rows[0].id;
    await db.query(
      `INSERT INTO stylist_services (stylist_id, service_id)
       SELECT $1, id FROM services WHERE tenant_id = $2 AND ($3::text IS NULL OR slug = $3)`,
      [id, t.id, only],
    );
    // Every day, all day, so the visit under way below has a shift too.
    for (let wd = 0; wd < 7; wd += 1) {
      await db.query("INSERT INTO stylist_hours (stylist_id, weekday, starts_at, ends_at) VALUES ($1, $2, '00:00', '23:45')", [id, wd]);
    }
    return id;
  };
  const dina = await mk('zz-dina', 'ZZ Dina', null);
  const kim = await mk('zz-kim', 'ZZ Kim', 'zz-cut');
  return { tenant: t, dina, kim };
}

async function book(tenant, o) {
  const c = await pool().connect();
  try {
    await c.query('BEGIN');
    const b = await createBooking(c, tenant, {
      stylistSlug: 'zz-dina', guestPhone: '8135550133', channel: 'staff', minLeadMin: 0, ...o,
    });
    await c.query('COMMIT');
    return b;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally { c.release(); }
}

const refused = (status, re) => (err) => err.status === status && re.test(err.message);
const blockedUntil = async (ref) => (await pool().query(
  "SELECT upper(during) AS t FROM appointments WHERE ref = $1", [ref],
)).rows[0].t;

test('a service added on the ticket lengthens the visit, holds the time, and keeps typed prices', { skip }, async () => {
  await cleanup();
  try {
    const { tenant } = await setup(pool());
    const at = (h, m = 0) => DAY.set({ hour: h, minute: m }).toISO();
    const visit = await book(tenant, { serviceSlug: 'zz-cut', start: at(10), guestName: 'ZZ Ticket Guest' });
    // The next client, the minute a cut and a gloss would end.
    await book(tenant, { serviceSlug: 'zz-cut', start: at(11, 45), guestName: 'ZZ Next Guest', guestPhone: '8135550134' });
    const ref = visit.ref;

    // The desk typed the cut's price; adding a service must not undo it.
    await setVisitPrice(tenant, OWNER, ref, { prices: [7000] });

    let t = await setVisitServices(tenant, OWNER, ref, { services: ['zz-cut', 'zz-gloss'] });
    assert.deepEqual(t.lines.map((l) => [l.name, l.priceCents, l.durationMin]),
      [['ZZ Cut', 7000, 60], ['ZZ Gloss', 3000, 45]], 'the typed price stays, the new service takes its own');
    assert.equal(t.totalCents, 10000);
    assert.equal(t.durationMin, 105);
    assert.equal(t.time, '10:00 AM');
    assert.equal(t.endTime, '11:45 AM', 'back to back with the next client');
    assert.deepEqual(t.serviceSlugs, ['zz-cut', 'zz-gloss']);
    assert.equal(+(await blockedUntil(ref)), +new Date(at(11, 45)), 'the book holds the added time');

    // Another hour would run into the next client: refused, nothing changes.
    await assert.rejects(setVisitServices(tenant, OWNER, ref, { services: ['zz-cut', 'zz-gloss', 'zz-single'] }),
      refused(409, /not free for that.*would run to/));
    t = await ticketFor(tenant, ref);
    assert.equal(t.durationMin, 105);
    assert.equal(t.totalCents, 10000);

    // Taking one off shortens it and gives the time back.
    t = await setVisitServices(tenant, OWNER, ref, { services: ['zz-gloss'] });
    assert.deepEqual(t.lines.map((l) => [l.name, l.priceCents]), [['ZZ Gloss', 3000]]);
    assert.equal(t.endTime, '10:45 AM');
    assert.equal(t.service, 'ZZ Gloss');

    // Nothing left is refused; so is a service that is not on the menu.
    await assert.rejects(setVisitServices(tenant, OWNER, ref, { services: [] }), refused(400, /at least one service/));
    await assert.rejects(setVisitServices(tenant, OWNER, ref, { services: ['zz-nope'] }), (e) => e.status === 404 || e.status === 409);

    // Every change is on the client's Admin activity.
    const detail = await contactDetail(tenant.id, visit.contact_id);
    const ev = detail.activity.filter((e) => e.title === 'Appointment services changed').map((e) => e.detail);
    assert.ok(ev.includes('ZZ Cut → ZZ Cut + ZZ Gloss'), ev.join(' | '));
    assert.ok(ev.includes('ZZ Cut + ZZ Gloss → ZZ Gloss'), ev.join(' | '));

    // A cancelled visit keeps what it had.
    await applyAppointmentAction(tenant, OWNER, ref, 'cancel');
    await assert.rejects(setVisitServices(tenant, OWNER, ref, { services: ['zz-cut'] }), refused(409, /cancelled/));
  } finally {
    await cleanup();
  }
});

test('two Color services go on one visit, end to end; a stylist is held to what they do', { skip }, async () => {
  await cleanup();
  try {
    const { tenant } = await setup(pool());
    const at = (h, m = 0) => DAY.set({ hour: h, minute: m }).toISO();
    // Item 3: Single Process and Partial Highlights at the same sitting.
    const both = await book(tenant, {
      serviceSlug: 'zz-single', extraServiceSlugs: ['zz-partial'], start: at(9), guestName: 'ZZ Color Guest',
    });
    let t = await ticketFor(tenant, both.ref);
    assert.deepEqual(t.lines.map((l) => l.name), ['ZZ Single Process', 'ZZ Partial Highlights']);
    // Each as Dina would do it (a single process is 45, 45 and 45 when she
    // typed nothing, timing.js), end to end with no gap between.
    const single = t.lines[0].durationMin;
    assert.equal(t.durationMin, single + 120, 'both services, end to end, no gap between');

    // Adding a Color to a single color on the ticket does the same.
    const one = await book(tenant, { serviceSlug: 'zz-single', start: at(14), guestName: 'ZZ Color Two', guestPhone: '8135550135' });
    t = await setVisitServices(tenant, OWNER, one.ref, { services: ['zz-single', 'zz-partial'] });
    assert.deepEqual(t.lines.map((l) => l.name), ['ZZ Single Process', 'ZZ Partial Highlights']);
    assert.equal(t.durationMin, single + 120);

    // Kim does cuts only: a gloss cannot go on her visit.
    const kims = await book(tenant, { serviceSlug: 'zz-cut', stylistSlug: 'zz-kim', start: at(10), guestName: 'ZZ Kim Guest', guestPhone: '8135550136' });
    await assert.rejects(setVisitServices(tenant, OWNER, kims.ref, { services: ['zz-cut', 'zz-gloss'] }),
      refused(409, /ZZ Kim does not do/));
  } finally {
    await cleanup();
  }
});

test('a visit already under way can still be added to, inside the shift and clear of blocks', { skip }, async () => {
  const now = DateTime.now().setZone(TZ);
  if (now.hour >= 21 || now.hour < 1) return;   // the visit below must stay inside today
  await cleanup();
  try {
    const { tenant, dina } = await setup(pool());
    const start = now.minus({ minutes: 30 }).startOf('minute');
    await pool().query(
      `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, starts_at, duration_min, buffer_min,
                                 during, guest_name, guest_phone, manage_token, channel, checked_in_at)
       SELECT $1, 'ZZTSV1', $2, v.id, $3::timestamptz, 60, 0,
              tstzrange($3::timestamptz, $3::timestamptz + interval '60 minutes'), 'ZZ In Chair', '8135550137',
              'tok-zztsv1', 'staff', now()
         FROM services v WHERE v.tenant_id = $1 AND v.slug = 'zz-cut'`,
      [tenant.id, dina, start.toISO()],
    );
    let t = await setVisitServices(tenant, OWNER, 'ZZTSV1', { services: ['zz-cut', 'zz-gloss'] });
    assert.equal(t.durationMin, 105, 'the gloss is added to a visit in the chair');

    // A block right after: adding another service would run into it.
    const end = start.plus({ minutes: 105 });
    await pool().query(
      "INSERT INTO time_off (tenant_id, stylist_id, during, reason) VALUES ($1, $2, tstzrange($3::timestamptz, $4::timestamptz), 'ZZ block')",
      [tenant.id, dina, end.toISO(), end.plus({ minutes: 60 }).toISO()],
    );
    await assert.rejects(setVisitServices(tenant, OWNER, 'ZZTSV1', { services: ['zz-cut', 'zz-gloss', 'zz-single'] }),
      refused(409, /not free for that/));
    t = await ticketFor(tenant, 'ZZTSV1');
    assert.equal(t.durationMin, 105);
  } finally {
    await cleanup();
    await pool().end();
    globalThis.__synergyPool = undefined;
  }
});
