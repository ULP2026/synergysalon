/**
 * Back to back (customer report, 2026-11-16): after a Perm from 10:00 to
 * 12:00, a Single Process Color could not be booked at 12:00; the first time
 * offered was 12:15, the Perm's 15-minute clean-down. Inside a colour's
 * processing break there was no gap. With the clean-downs at 0 the next
 * visit starts the minute the last one ends, an overlap is still refused by
 * the app and by the database, and the processing break works as before.
 *
 * Runs in a throwaway ZZ tenant and removes it; the change is applied to
 * that tenant only (dropCleanDowns), never to the whole database.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';

import { availableSlots } from '../api/_lib/availability.js';
import { createBooking } from '../api/_lib/booking.js';
import { CLEAN_DOWN_MARK, DROP_CLEAN_DOWNS_ONCE, dropCleanDowns } from '../api/_lib/clean-down.js';
import { pool } from '../api/_lib/db.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
const TZ = 'America/New_York';
let SAT = DateTime.now().setZone(TZ).plus({ days: 20 }).startOf('day');
while (SAT.weekday !== 6) SAT = SAT.plus({ days: 1 });

const cleanup = () => pool().query("DELETE FROM tenants WHERE slug = 'zz-gap'");

async function setup(db) {
  const t = (await db.query(
    "INSERT INTO tenants (slug, name, timezone) VALUES ('zz-gap', 'ZZ Gap', $1) RETURNING id, slug, name, timezone", [TZ],
  )).rows[0];
  // As seeded on the live menu: Perm 120 + 15, Single Process Color 90 + 15, a cut + 10.
  for (const [slug, name, cat, min, buf] of [
    ['zz-perm', 'ZZ Perm', 'treatments', 120, 15], ['zz-spc', 'ZZ Single Process Color', 'color', 90, 15],
    ['zz-cut', 'ZZ Cut', 'cuts', 30, 10]]) {
    await db.query(
      `INSERT INTO services (tenant_id, slug, name, category, duration_min, buffer_min) VALUES ($1, $2, $3, $4, $5, $6)`,
      [t.id, slug, name, cat, min, buf],
    );
  }
  // The colour in three parts, so it has a processing break (never under 45
  // minutes, timing.js): 30 / 45 processing / 30.
  const st = (await db.query(
    `INSERT INTO stylists (tenant_id, slug, name, service_details)
     VALUES ($1, 'zz-dina', 'ZZ Dina', '{"lunch": false, "color": {"on": true, "start": 30, "break": 30, "finish": 30}}') RETURNING id`, [t.id],
  )).rows[0].id;
  await db.query('INSERT INTO stylist_services (stylist_id, service_id) SELECT $1, id FROM services WHERE tenant_id = $2', [st, t.id]);
  await db.query("INSERT INTO stylist_hours (stylist_id, weekday, starts_at, ends_at) VALUES ($1, 6, '09:00', '18:00')", [st]);
  return t;
}

async function book(db, tenant, slug, hh, mm = 0, name = 'ZZ Gap Guest') {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const b = await createBooking(c, tenant, {
      serviceSlug: slug, stylistSlug: 'zz-dina', start: SAT.set({ hour: hh, minute: mm }).toISO(),
      guestName: name, guestPhone: '8135550144', channel: 'staff', minLeadMin: 0,
    });
    await c.query('COMMIT');
    return b;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally { c.release(); }
}

async function times(db, tenant, slug) {
  const c = await db.connect();
  try {
    const { days } = await availableSlots(c, tenant, { serviceSlug: slug, stylistSlug: 'zz-dina', fromDate: SAT.toISODate(), toDate: SAT.toISODate(), minLeadMin: 0 });
    return days.flatMap((d) => d.slots).map((x) => DateTime.fromISO(x.start).setZone(TZ).toFormat('h:mm a'));
  } finally { c.release(); }
}

const refusal = async (p) => { try { await p; return null; } catch (err) { return err.message; } };

test('the next visit can start the minute the last one ends; overlap is still refused', { skip }, async () => {
  await cleanup();
  const db = pool();
  const evidence = [];
  const say = (line) => { evidence.push(line); };
  try {
    const tenant = await setup(db);
    const perm = await book(db, tenant, 'zz-perm', 10);              // 10:00 to 12:00
    const color = await book(db, tenant, 'zz-spc', 15, 0, 'ZZ Gap Colour'); // 15:00 to 16:45, processing 15:30 to 16:15
    say(`Saturday ${SAT.toISODate()}, ZZ Dina: Perm 10:00 AM to 12:00 PM; colour 3:00 to 4:45 PM, processing 3:30 to 4:15 PM.`);

    // ── before: her report ──
    let spc = await times(db, tenant, 'zz-spc');
    say(`BEFORE  Single Process Color times around noon: ${spc.filter((x) => /^1[12]:/.test(x)).join(', ')}`);
    assert.ok(!spc.includes('12:00 PM') && spc.includes('12:15 PM'), 'the 15-minute clean-down holds 12:00');
    const before = await refusal(book(db, tenant, 'zz-spc', 12));
    say(`BEFORE  booking it at 12:00 PM: ${before ? `refused (${before})` : 'booked'}`);
    assert.ok(before, '12:00 is refused');
    let cut = await times(db, tenant, 'zz-cut');
    say(`BEFORE  a 30-min cut inside the colour's processing (3:30 PM): ${cut.includes('3:30 PM') ? 'offered' : 'not offered'}`);
    assert.ok(cut.includes('3:30 PM'), 'the processing break had no gap');

    // ── the fix, for this tenant only ──
    const changed = await dropCleanDowns(db.query.bind(db), tenant.id);
    say(`FIX     clean-downs set to 0: ${changed.services} services, ${changed.appointments} booked visits shortened`);
    const { rows: [p] } = await db.query('SELECT buffer_min, upper(during) AS ends FROM appointments WHERE ref = $1', [perm.ref]);
    assert.equal(p.buffer_min, 0);
    say(`AFTER   the Perm now holds Dina until ${DateTime.fromJSDate(p.ends).setZone(TZ).toFormat('h:mm a')}`);

    // ── after ──
    spc = await times(db, tenant, 'zz-spc');
    say(`AFTER   Single Process Color times around noon: ${spc.filter((x) => /^1[12]:/.test(x)).join(', ')}`);
    assert.ok(spc.includes('12:00 PM'), '12:00 is offered');
    const at12 = await book(db, tenant, 'zz-spc', 12, 0, 'ZZ Gap Back To Back');
    say(`AFTER   booking it at 12:00 PM: booked (${at12.ref})`);

    // No overlap, still: the app refuses it, and so does the database.
    const overlap = await refusal(book(db, tenant, 'zz-cut', 11, 45, 'ZZ Gap Overlap'));
    say(`AFTER   a cut at 11:45 AM, inside the Perm: ${overlap ? `refused (${overlap})` : 'BOOKED (wrong)'}`);
    assert.ok(overlap, 'a visit inside the Perm is refused');
    const dbRefusal = await refusal(db.query(
      `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, starts_at, duration_min, buffer_min, during, guest_name, guest_phone, manage_token, channel)
       SELECT $1, 'ZZGAPX', s.id, v.id, $2::timestamptz, 30, 0, tstzrange($2::timestamptz, $2::timestamptz + interval '30 minutes'), 'ZZ Gap Raw', '8135550145', 'tok-zzgapx', 'staff'
         FROM stylists s, services v WHERE s.tenant_id = $1 AND v.tenant_id = $1 AND v.slug = 'zz-cut'`,
      [tenant.id, SAT.set({ hour: 11, minute: 45 }).toISO()],
    ));
    say(`AFTER   the same overlap written straight to the database: ${dbRefusal ? 'refused by the no-overlap constraint' : 'ACCEPTED (wrong)'}`);
    assert.match(dbRefusal || '', /appointments_no_overlap/);

    cut = await times(db, tenant, 'zz-cut');
    say(`AFTER   a 30-min cut inside the colour's processing (3:30 PM): ${cut.includes('3:30 PM') ? 'offered' : 'not offered'}; at 3:15 PM, over the colour's start: ${cut.includes('3:15 PM') ? 'OFFERED (wrong)' : 'not offered'}`);
    assert.ok(cut.includes('3:30 PM') && !cut.includes('3:15 PM'));
    // Right after the colour ends, too.
    assert.ok(cut.includes('4:45 PM'), 'the minute the colour ends');
    say(`AFTER   a cut at 4:45 PM, the minute the colour ends: ${cut.includes('4:45 PM') ? 'offered' : 'not offered'}`);
    assert.ok(cut.includes('9:30 AM'), 'and the minute before the Perm starts');
    say(`AFTER   a cut at 9:30 AM, ending the minute the Perm starts: ${cut.includes('9:30 AM') ? 'offered' : 'not offered'}`);
  } finally {
    console.log(`\n--- evidence ---\n${evidence.join('\n')}\n--- end ---`);
    await cleanup();
  }
});

test('the database-wide change runs once: a clean-down set on purpose later is kept', { skip }, async () => {
  await cleanup();
  const db = pool();
  try {
    const tenant = await setup(db);
    // Inside one transaction that is rolled back, so the other test files
    // running at the same time never see the database "not done" and never
    // have their own services zeroed. It holds the services table only for
    // the few statements below, and waits at most 2 seconds to get it.
    const run = async () => {
      const c = await db.connect();
      try {
        await c.query('BEGIN');
        await c.query("SET LOCAL lock_timeout = '2s'");
        // This database as it was before the change, then a cold start.
        await c.query('COMMENT ON COLUMN services.buffer_min IS NULL');
        await c.query('ALTER TABLE services ALTER COLUMN buffer_min SET DEFAULT 15');
        await c.query(DROP_CLEAN_DOWNS_ONCE);
        const { rows: [m] } = await c.query(
          `SELECT col_description('services'::regclass, a.attnum) AS mark, pg_get_expr(d.adbin, d.adrelid) AS dflt
             FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE a.attrelid = 'services'::regclass AND a.attname = 'buffer_min'`,
        );
        const { rows: [z] } = await c.query("SELECT buffer_min FROM services WHERE tenant_id = $1 AND slug = 'zz-perm'", [tenant.id]);
        // A service given a clean-down on purpose after the change keeps it.
        await c.query("UPDATE services SET buffer_min = 10 WHERE tenant_id = $1 AND slug = 'zz-cut'", [tenant.id]);
        await c.query(DROP_CLEAN_DOWNS_ONCE);
        const { rows: [k] } = await c.query("SELECT buffer_min FROM services WHERE tenant_id = $1 AND slug = 'zz-cut'", [tenant.id]);
        return { mark: m.mark, dflt: m.dflt, perm: z.buffer_min, kept: k.buffer_min };
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
      }
    };
    let out;
    for (let i = 0; !out; i += 1) {
      try { out = await run(); } catch (err) {
        if (err.code !== '55P03' || i >= 10) throw err;
        await new Promise((r) => { setTimeout(r, 300); });
      }
    }
    assert.equal(out.mark, CLEAN_DOWN_MARK);
    assert.equal(out.dflt, '0');
    assert.equal(out.perm, 0, 'every service zeroed');
    assert.equal(out.kept, 10, 'a second run changes nothing');
  } finally {
    await cleanup();
    await pool().end();
    globalThis.__synergyPool = undefined;
  }
});
