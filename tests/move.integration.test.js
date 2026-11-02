/**
 * Appt. Book's drag and drop (2026-11-02): POST /api/staff/appointment
 * {action: 'move'} moves a booking to a new time or another stylist, by the
 * desk's rules, inside the stylist's hours and the salon's.
 *
 * Skips without DATABASE_URL. Runs in a throwaway ZZ tenant and removes it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';

import { createSession } from '../api/_lib/auth.js';
import { availableSlots } from '../api/_lib/availability.js';
import { pool } from '../api/_lib/db.js';
import { SALON_HOURS } from '../api/_lib/salon-hours.js';
import appointment from '../api/staff/_routes/appointment.js';
import diary from '../api/staff/_routes/diary.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const TZ = 'America/New_York';
const SLUG = 'zz-move';

// A Saturday well ahead, so lead time and the horizon never interfere.
let DAY = DateTime.now().setZone(TZ).plus({ days: 20 }).startOf('day');
while (DAY.weekday !== 6) DAY = DAY.plus({ days: 1 });
const at = (h, m = 0) => DAY.set({ hour: h, minute: m });
const hhmm = (iso) => DateTime.fromJSDate(new Date(iso)).setZone(TZ).toFormat('HH:mm');

const cleanup = () => pool().query('DELETE FROM tenants WHERE slug = $1', [SLUG]);

async function setup() {
  const db = pool();
  // This salon opens 9 to 3 on Saturdays and is shut on Sundays; its
  // stylists' shifts were typed 8 to 5, longer than the salon's day.
  SALON_HOURS[SLUG] = { 0: null, 6: ['09:00', '15:00'] };
  const t = (await db.query(
    `INSERT INTO tenants (slug, name, timezone) VALUES ($1, 'ZZ Move', $2) RETURNING *`, [SLUG, TZ],
  )).rows[0];
  const v = (await db.query(
    `INSERT INTO services (tenant_id, slug, name, category, duration_min, buffer_min)
     VALUES ($1, 'zz-cut', 'ZZ Cut', 'cuts', 60, 15) RETURNING id`, [t.id],
  )).rows[0].id;
  const ids = {};
  for (const [slug, name] of [['zz-ana', 'ZZ Ana'], ['zz-bea', 'ZZ Bea']]) {
    const s = (await db.query(
      `INSERT INTO stylists (tenant_id, slug, name, service_details)
       VALUES ($1, $2, $3, '{"lunch": false}'::jsonb) RETURNING id`, [t.id, slug, name],
    )).rows[0].id;
    ids[slug] = s;
    await db.query('INSERT INTO stylist_services (stylist_id, service_id) VALUES ($1, $2)', [s, v]);
    await db.query(
      `INSERT INTO stylist_hours (stylist_id, weekday, starts_at, ends_at)
       VALUES ($1, 6, '08:00', '17:00'), ($1, 0, '09:00', '15:00')`, [s],
    );
  }
  const appt = async (stylist, start, ref) => (await db.query(
    `INSERT INTO appointments (tenant_id, ref, manage_token, stylist_id, service_id, starts_at, duration_min,
                               buffer_min, during, guest_name, guest_email, channel)
     VALUES ($1, $2, 'zz-token-' || $2, $3, $4, $5::timestamptz, 60, 15,
             tstzrange($5::timestamptz, $5::timestamptz + interval '75 minutes', '[)'),
             'ZZ Guest', 'zz-move@example.com', 'staff') RETURNING id`,
    [t.id, ref, ids[stylist], v, start.toISO()],
  )).rows[0].id;
  const desk = (await db.query(
    `INSERT INTO staff_users (tenant_id, email, password_hash, name, role)
     VALUES ($1, 'zz-move-desk@example.com', 'x', 'ZZ Desk', 'front_desk') RETURNING *`, [t.id],
  )).rows[0];
  const res = { headers: {}, setHeader(k, v2) { this.headers[k.toLowerCase()] = v2; } };
  await createSession(res, desk);
  const cookie = String(res.headers['set-cookie']).split(';')[0];
  return { tenant: t, ids, appt, cookie };
}

function call(route, cookie, { method = 'GET', url: u, body } = {}) {
  return new Promise((resolve) => {
    const out = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }); },
    };
    const raw = body ? JSON.stringify(body) : '';
    const req = {
      method, url: u,
      headers: { cookie, host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' },
      body,
      async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw); },
    };
    route(req, out);
  });
}

const move = (cookie, body) => call(appointment, cookie, {
  method: 'POST', url: '/api/staff/appointment', body: { action: 'move', ...body },
});

test('shifts longer than the salon’s day are offered only inside it, and never on a closed day', { skip }, async () => {
  await cleanup();
  const { tenant } = await setup();
  const client = await pool().connect();
  try {
    const { days, open } = await availableSlots(client, tenant, {
      serviceSlug: 'zz-cut', stylistSlug: null, fromDate: DAY.toISODate(), toDate: DAY.plus({ days: 1 }).toISODate(),
    });
    const sat = days.find((d) => d.date === DAY.toISODate());
    const starts = sat.slots.map((s) => hhmm(s.start));
    assert.equal(starts[0], '09:00', 'not 8:00, when the salon is still shut');
    assert.equal(starts.at(-1), '14:00', 'finishing by 3, not 5');
    assert.deepEqual(open[DAY.toISODate()], [540, 900]);
    assert.ok(!days.some((d) => d.date === DAY.plus({ days: 1 }).toISODate()), 'nothing on Sunday');
  } finally {
    client.release();
    await cleanup();
    delete SALON_HOURS[SLUG];
  }
});

test("Appt. Book's day is the salon's hours, and a closed day says so", { skip }, async () => {
  await cleanup();
  const { cookie } = await setup();
  try {
    const sat = await call(diary, cookie, { url: `/api/staff/diary?date=${DAY.toISODate()}` });
    assert.equal(sat.status, 200);
    assert.deepEqual(sat.body.salonHours, [540, 900]);
    assert.equal(sat.body.salonClosed, false);
    assert.deepEqual(sat.body.hours['zz-ana'], [[540, 900]], 'the 8 to 5 shift drawn as 9 to 3');
    const sun = await call(diary, cookie, { url: `/api/staff/diary?date=${DAY.plus({ days: 1 }).toISODate()}` });
    assert.equal(sun.body.salonClosed, true);
    assert.deepEqual(sun.body.hours['zz-ana'], []);
  } finally {
    await cleanup();
    delete SALON_HOURS[SLUG];
  }
});

test('a dragged booking moves to a free time and to another stylist', { skip }, async () => {
  await cleanup();
  const { ids, appt, cookie } = await setup();
  const db = pool();
  try {
    const id = await appt('zz-ana', at(10), 'ZZMV01');
    let r = await move(cookie, { ref: 'ZZMV01', start: at(11, 15).toISO() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.moved, true);
    let row = (await db.query('SELECT starts_at, stylist_id, extract(epoch FROM upper(during) - lower(during))::int / 60 AS len FROM appointments WHERE id = $1', [id])).rows[0];
    assert.equal(hhmm(row.starts_at), '11:15');
    assert.equal(row.stylist_id, ids['zz-ana']);
    assert.equal(row.len, 75, 'keeps its own length and clean-down');

    // Into Bea's column.
    r = await move(cookie, { ref: 'ZZMV01', start: at(12).toISO(), stylist: 'zz-bea' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.stylistSlug, 'zz-bea');
    row = (await db.query('SELECT starts_at, stylist_id FROM appointments WHERE id = $1', [id])).rows[0];
    assert.equal(hhmm(row.starts_at), '12:00');
    assert.equal(row.stylist_id, ids['zz-bea']);
  } finally {
    await cleanup();
    delete SALON_HOURS[SLUG];
  }
});

test('a drop that does not fit is refused and the booking stays put', { skip }, async () => {
  await cleanup();
  const { appt, cookie } = await setup();
  const db = pool();
  try {
    const id = await appt('zz-ana', at(10), 'ZZMV02');
    await appt('zz-ana', at(12), 'ZZMV03');
    const tries = [
      at(8, 30),             // before the salon opens, though her shift says 8
      at(14, 30),            // would run past 3
      at(11, 30),            // into the 12:00 booking
      DAY.plus({ days: 1 }).set({ hour: 10 }),   // Sunday: closed
    ];
    for (const start of tries) {
      const r = await move(cookie, { ref: 'ZZMV02', start: start.toISO() });
      assert.equal(r.status, 409, `${start.toISO()} should be refused`);
    }
    const row = (await db.query('SELECT starts_at FROM appointments WHERE id = $1', [id])).rows[0];
    assert.equal(hhmm(row.starts_at), '10:00');

    // A cancelled one is not moved either.
    await db.query("UPDATE appointments SET status = 'cancelled' WHERE id = $1", [id]);
    const r = await move(cookie, { ref: 'ZZMV02', start: at(13).toISO() });
    assert.equal(r.status, 409);
  } finally {
    await cleanup();
    delete SALON_HOURS[SLUG];
  }
});
