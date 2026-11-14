/**
 * What Karen in the app can now get done (asked for 2026-11-14): block days
 * off, take a block away, move an appointment, change a visit's price, add
 * a note, change working hours, change a stylist's own service price and
 * minutes. Each only proposes; Confirm carries it out through the app's own
 * functions, and a stylist reaches only their own chair.
 *
 * Runs in a throwaway ZZ tenant and removes it. The model is not involved:
 * these are the tools it calls, driven directly.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';

import { availableSlots } from '../api/_lib/availability.js';
import { createBooking } from '../api/_lib/booking.js';
import { pool } from '../api/_lib/db.js';
import { confirm, propose } from '../api/_lib/karen-actions.js';
import { interpretReply } from '../api/_lib/karen-desk.js';
import { timedService } from '../api/_lib/timing.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
const TZ = 'America/New_York';
let WED = DateTime.now().setZone(TZ).plus({ days: 20 }).startOf('day');
while (WED.weekday !== 3) WED = WED.plus({ days: 1 });
const THU = WED.plus({ days: 1 });
const FRI = WED.plus({ days: 2 });

const cleanup = () => pool().query("DELETE FROM tenants WHERE slug = 'zz-kchg'");

async function setup(db) {
  const t = (await db.query(
    "INSERT INTO tenants (slug, name, timezone) VALUES ('zz-kchg', 'ZZ Karen Changes', $1) RETURNING id, slug, name, timezone",
    [TZ],
  )).rows[0];
  await db.query(
    `INSERT INTO services (tenant_id, slug, name, category, duration_min, buffer_min, price_cents)
     VALUES ($1, 'zz-cut', 'ZZ Cut', 'cuts', 60, 0, 6500)`, [t.id],
  );
  const login = async (email, name, role) => (await db.query(
    `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, onboarded_at)
     VALUES ($1, $2, 'x', $3, $4, now()) RETURNING id, tenant_id, name, role, email`, [t.id, email, name, role],
  )).rows[0];
  const owner = await login('zz-kchg-owner@example.com', 'ZZ Owner', 'owner');
  const micahLogin = await login('zz-kchg-micah@example.com', 'ZZ Micah', 'stylist');
  // Dina: a chair without a sign-in. Micah: a chair with one.
  const dina = (await db.query(
    `INSERT INTO stylists (tenant_id, slug, name, service_details) VALUES ($1, 'zz-dina', 'ZZ Dina', '{"lunch": false}') RETURNING id`, [t.id],
  )).rows[0].id;
  const micah = (await db.query(
    `INSERT INTO stylists (tenant_id, slug, name, staff_user_id) VALUES ($1, 'zz-micah', 'ZZ Micah', $2) RETURNING id`, [t.id, micahLogin.id],
  )).rows[0].id;
  await db.query("UPDATE staff_users SET services = '{\"lunch\": false, \"cuts\": {\"on\": true}}'::jsonb WHERE id = $1", [micahLogin.id]);
  for (const st of [dina, micah]) {
    await db.query('INSERT INTO stylist_services (stylist_id, service_id) SELECT $1, id FROM services WHERE tenant_id = $2', [st, t.id]);
    // Wednesday and Friday, 9 to 5; Thursday off.
    await db.query("INSERT INTO stylist_hours (stylist_id, weekday, starts_at, ends_at) VALUES ($1, 3, '09:00', '17:00'), ($1, 5, '09:00', '17:00')", [st]);
  }
  return { tenant: t, owner, micahLogin, dina, micah };
}

/** Propose, then press Confirm, as the console does. */
async function proposeAndConfirm(ctx, input) {
  const out = await propose(ctx, input);
  assert.ok(out.proposal, `a card for ${input.type}: ${JSON.stringify(out)}`);
  return { card: out, done: await confirm(ctx, out.proposal.id) };
}

test('Karen blocks days off, moves, prices, notes, and changes hours and services, only once confirmed', { skip }, async () => {
  await cleanup();
  const db = pool();
  try {
    const { tenant, owner, micahLogin, dina } = await setup(db);
    const asOwner = { tenant, user: owner };
    const asMicah = { tenant, user: micahLogin };

    // ── blocks: "block off my book on Wednesday and Thursday" ──
    const blk = await propose(asOwner, { type: 'block', stylist: 'zz-dina', reason: 'Vacation', days: [{ date: WED.toISODate() }, { date: THU.toISODate() }] });
    assert.equal(blk.proposal.lines.length, 1, 'Wednesday is blocked');
    assert.match(blk.proposal.lines[0], /9:00 AM to 5:00 PM · Vacation/);
    assert.match(blk.skipped[0].why, /doesn't work on Thursdays/, 'Thursday is a day off already');
    let { rows } = await db.query('SELECT count(*)::int AS n FROM time_off WHERE stylist_id = $1', [dina]);
    assert.equal(rows[0].n, 0, 'nothing saved before Confirm');
    const blkDone = await confirm(asOwner, blk.proposal.id);
    assert.match(blkDone.say, /^Done\. Blocked/);
    const c = await db.connect();
    try {
      const { days } = await availableSlots(c, tenant, { serviceSlug: 'zz-cut', stylistSlug: 'zz-dina', fromDate: WED.toISODate(), toDate: WED.toISODate(), minLeadMin: 0 });
      assert.equal(days.flatMap((d) => d.slots).length, 0, 'a blocked day offers no times');
    } finally { c.release(); }

    // A stylist blocks only their own chair.
    const notMine = await propose(asMicah, { type: 'block', stylist: 'zz-dina', days: [{ date: FRI.toISODate() }] });
    assert.match(notMine.error, /only change your own chair|only block your own/i);
    const mine = await proposeAndConfirm(asMicah, { type: 'block', stylist: 'zz-micah', days: [{ date: FRI.toISODate(), from: '1pm', to: '15:00' }] });
    assert.match(mine.card.proposal.lines[0], /1:00 PM to 3:00 PM/);

    // Taking a block away again.
    ({ rows } = await db.query('SELECT id FROM time_off WHERE stylist_id = $1', [dina]));
    const un = await proposeAndConfirm(asOwner, { type: 'unblock', ids: [rows[0].id] });
    assert.match(un.done.say, /gone/);
    ({ rows } = await db.query('SELECT count(*)::int AS n FROM time_off WHERE stylist_id = $1', [dina]));
    assert.equal(rows[0].n, 0);

    // ── a visit: move it, price it, note it ──
    const cl = await db.connect();
    let booked;
    try {
      await cl.query('BEGIN');
      booked = await createBooking(cl, tenant, {
        serviceSlug: 'zz-cut', stylistSlug: 'zz-dina', start: FRI.set({ hour: 10 }).toISO(),
        guestName: 'ZZ Karen Guest', guestPhone: '8135550133', channel: 'staff', minLeadMin: 0,
      });
      await cl.query('COMMIT');
    } finally { cl.release(); }

    const late = await propose(asOwner, { type: 'move', ref: booked.ref, date: FRI.toISODate(), time: '20:00' });
    assert.equal(late.nothing, true, 'outside her hours is not offered');
    assert.deepEqual(late.free_that_day, ['9:00 AM to 4:00 PM (every 15 min)'], 'the free times come back instead, as runs');
    const mv = await proposeAndConfirm(asOwner, { type: 'move', ref: booked.ref, date: FRI.toISODate(), time: '13:00', notify: false });
    assert.match(mv.card.proposal.lines.join(' '), /not told/);
    ({ rows } = await db.query('SELECT starts_at FROM appointments WHERE ref = $1', [booked.ref]));
    assert.equal(DateTime.fromJSDate(rows[0].starts_at).setZone(TZ).toFormat('HH:mm'), '13:00');

    assert.match((await propose(asMicah, { type: 'price', ref: booked.ref, prices: [80] })).error, /No appointment|owner, an admin or a manager/);
    const pr = await proposeAndConfirm(asOwner, { type: 'price', ref: booked.ref, prices: [80] });
    assert.match(pr.card.proposal.lines.join(' '), /ZZ Cut: \$65, now \$80/);
    ({ rows } = await db.query('SELECT price_cents, notes FROM appointments WHERE ref = $1', [booked.ref]));
    assert.equal(rows[0].price_cents, 8000);

    await proposeAndConfirm(asOwner, { type: 'note', ref: booked.ref, note: 'Bring photos of the colour she wants' });
    ({ rows } = await db.query('SELECT notes FROM appointments WHERE ref = $1', [booked.ref]));
    assert.match(rows[0].notes, /ZZ Owner\): Bring photos/);

    // ── hours: Wednesday becomes 10 to 2; Friday is left alone ──
    const hr = await proposeAndConfirm(asOwner, { type: 'hours', stylist: 'zz-dina', days: [{ weekday: 'wed', shifts: [{ from: '10am', to: '2pm' }] }] });
    assert.match(hr.card.proposal.lines[0], /Wednesday: 9:00 AM to 5:00 PM, now 10:00 AM to 2:00 PM/);
    ({ rows } = await db.query("SELECT weekday, to_char(starts_at, 'HH24:MI') s, to_char(ends_at, 'HH24:MI') e FROM stylist_hours WHERE stylist_id = $1 ORDER BY weekday", [dina]));
    assert.deepEqual(rows.map((r) => [r.weekday, r.s, r.e]), [[3, '10:00', '14:00'], [5, '09:00', '17:00']]);

    // ── services: Dina's own price and minutes for the cut ──
    const sv = await proposeAndConfirm(asOwner, { type: 'service', stylist: 'zz-dina', changes: [{ service: 'zz-cut', price: 55, minutes: 50 }] });
    assert.match(sv.card.proposal.lines[0], /price \$65, now \$55, 60 minutes, now 50/);
    ({ rows } = await db.query("SELECT service_details FROM stylists WHERE id = $1", [dina]));
    const t = timedService({ slug: 'zz-cut', name: 'ZZ Cut', category: 'cuts', duration_min: 60, price_cents: 6500 }, rows[0].service_details);
    assert.deepEqual([t.price_cents, t.duration_min], [5500, 50]);
    // Micah's are on his login, and he may change his own.
    await proposeAndConfirm(asMicah, { type: 'service', stylist: 'zz-micah', changes: [{ service: 'zz-cut', price: 48 }] });
    ({ rows } = await db.query('SELECT services FROM staff_users WHERE id = $1', [micahLogin.id]));
    assert.equal(rows[0].services.items['zz-cut'].price, 48);
    ({ rows } = await db.query("SELECT count(*)::int AS n FROM stylist_services ss JOIN stylists s ON s.id = ss.stylist_id WHERE s.slug = 'zz-micah'"));
    assert.equal(rows[0].n, 1, 'still offers the cut');

    // A proposal lives for one confirm: pressing it again does nothing.
    const again = await confirm(asOwner, pr.card.proposal.id);
    assert.equal(again.done, false);
  } finally {
    await cleanup();
  }
});

test('a typed reply is read against the step\'s choices', async () => {
  const stand = (answer) => ({ messages: { create: async () => ({ content: [{ type: 'text', text: answer }] }) } });
  const opts = ['Just Women\'s Cut', 'No, that\'s everything', '+ Gloss'];
  assert.deepEqual(await interpretReply(stand('2'), { question: 'Anything else?', options: opts, text: 'Thatsall' }), { choice: 1 });
  assert.deepEqual(await interpretReply(stand('other'), { question: 'Anything else?', options: opts, text: 'block my friday' }), { choice: null, other: true });
  assert.deepEqual(await interpretReply(stand('7'), { question: 'Anything else?', options: opts, text: 'hmm' }), { choice: null, other: false });
  await pool().end().catch(() => {});
  globalThis.__synergyPool = undefined;
});
