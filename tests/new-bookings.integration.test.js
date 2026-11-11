/**
 * Home's New bookings card (newBookings in api/staff/_routes/home.js): how
 * many bookings were made today, this week and this month, by whom, and how
 * many are a first visit.
 *
 *   TEST_DATABASE_URL=postgres://… npm test
 *
 * newBookings reads through the shared pool, which only sees committed rows,
 * so this commits -- into a ZZ salon of its own, removed in the finally.
 * "Now" is pinned (Wed 11 Nov 2026, 10:00 AM in New York), so the week starts
 * Monday 9 Nov and the month Sunday 1 Nov, on the salon's clock.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';
import pg from 'pg';

import { newBookings } from '../api/staff/_routes/home.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const isLocal = url?.includes('localhost') || url?.includes('127.0.0.1');
const TZ = 'America/New_York';
const NOW = DateTime.fromISO('2026-11-11T10:00:00', { zone: TZ });
const et = (s) => DateTime.fromISO(s, { zone: TZ }).toISO();

let n = 0;
async function booking(c, t, { made, starts, contact = null, channel = 'online',
  via = null, status = 'booked', notes = '' }) {
  n += 1;
  // Each its own hour, or the no-overlap constraint refuses the second.
  starts ??= DateTime.fromISO('2026-11-20T00:00:00', { zone: TZ }).plus({ hours: n }).toISO({ includeOffset: false });
  await c.query(
    `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, contact_id, starts_at, duration_min, buffer_min,
                               during, guest_name, guest_email, guest_phone, manage_token, status, channel,
                               booked_via, notes, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, 60, 0,
             tstzrange($6::timestamptz, $6::timestamptz + interval '60 minutes', '[)'),
             'ZZ Guest', 'zz@example.com', '8135550100', $7, $8::appointment_status, $9::booking_channel,
             $10, $11, $12::timestamptz)`,
    [t.id, `ZZNB${Date.now() % 100000}${n}`, t.stylist, t.service, contact, et(starts),
      `zz-nb-${Date.now()}-${n}`, status, channel, via, notes, et(made)],
  );
}

test('New bookings: counted by when they were made, on the salon clock, imports left out', { skip }, async () => {
  const c = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await c.connect();
  let tenantId = null;
  try {
    const t = (await c.query(
      `INSERT INTO tenants (slug, name, timezone) VALUES ($1, 'ZZ New Bookings', $2) RETURNING id, timezone`,
      [`zz-nb-${Date.now()}`, TZ],
    )).rows[0];
    tenantId = t.id;
    t.stylist = (await c.query(
      "INSERT INTO stylists (tenant_id, slug, name) VALUES ($1, 'zz-ana', 'ZZ Ana') RETURNING id", [t.id])).rows[0].id;
    t.service = (await c.query(
      `INSERT INTO services (tenant_id, slug, name, category, duration_min)
       VALUES ($1, 'zz-cut', 'ZZ Cut', 'cuts', 60) RETURNING id`, [t.id])).rows[0].id;
    const client = async (name) => (await c.query(
      "INSERT INTO contacts (tenant_id, name, phone) VALUES ($1, $2, '8135550100') RETURNING id", [t.id, name])).rows[0].id;
    const [amy, bea, cal, dee] = [await client('ZZ Amy'), await client('ZZ Bea'), await client('ZZ Cal'), await client('ZZ Dee')];

    // Bea has been before: her October visit makes this week's booking a return.
    await booking(c, t, { made: '2026-10-01T09:00:00', starts: '2026-10-02T10:00:00', contact: bea });

    // Today: Amy on the website, her first visit.
    await booking(c, t, { made: '2026-11-11T09:00:00', contact: amy });
    // This week: Bea at the front desk (Monday), Cal by Karen (Tuesday).
    await booking(c, t, { made: '2026-11-09T00:30:00', contact: bea, channel: 'staff' });
    await booking(c, t, { made: '2026-11-10T14:00:00', contact: cal, channel: 'staff', via: 'karen' });
    // This week, then cancelled: counted apart, never in the total.
    await booking(c, t, { made: '2026-11-10T15:00:00', contact: dee, status: 'cancelled' });
    // Sunday night is last week, though it is already Monday in UTC.
    await booking(c, t, { made: '2026-11-08T23:30:00', contact: dee });
    // Copied in from Envision on Nov 6: made in Envision, not a new booking.
    await booking(c, t, { made: '2026-11-06T12:00:00', contact: dee, channel: 'staff',
      notes: 'Imported from Envision.' });
    // Halloween night is October on the salon's clock, though November in UTC.
    await booking(c, t, { made: '2026-10-31T23:30:00', contact: dee });

    const nb = await newBookings({ id: t.id, timezone: TZ }, NOW, null);
    assert.deepEqual(nb.counts.today, { total: 1, website: 1, karen: 0, desk: 0, first: 1, cancelled: 0 });
    assert.deepEqual(nb.counts.week, { total: 3, website: 1, karen: 1, desk: 1, first: 2, cancelled: 1 });
    // The month adds Sunday's booking (Dee's first kept visit); not the import, not Halloween.
    assert.deepEqual(nb.counts.month, { total: 4, website: 2, karen: 1, desk: 1, first: 3, cancelled: 1 });

    // The list is the month's kept bookings, newest first, each tagged with its periods.
    assert.deepEqual(nb.items.map((i) => [i.from, i.firstVisit, i.periods.join(',')]), [
      ['website', true, 'today,week,month'],
      ['karen', true, 'week,month'],
      ['desk', false, 'week,month'],
      ['website', true, 'month'],
    ]);

    // Only one stylist's chair: the same rule Home uses for a stylist.
    const none = await newBookings({ id: t.id, timezone: TZ }, NOW, ['00000000-0000-0000-0000-000000000000']);
    assert.equal(none.counts.month.total, 0);
    assert.equal(none.items.length, 0);

    // A week that began last month is counted whole: Wed 2 Dec's week starts Mon 30 Nov.
    await booking(c, t, { made: '2026-11-30T11:00:00', contact: amy });
    const dec = await newBookings({ id: t.id, timezone: TZ }, DateTime.fromISO('2026-12-02T10:00:00', { zone: TZ }), null);
    assert.equal(dec.counts.week.total, 1);
    assert.equal(dec.counts.month.total, 0);
  } finally {
    if (tenantId) {
      await c.query('DELETE FROM appointments WHERE tenant_id = $1', [tenantId]);
      await c.query('DELETE FROM contacts WHERE tenant_id = $1', [tenantId]);
      await c.query('DELETE FROM stylists WHERE tenant_id = $1', [tenantId]);
      await c.query('DELETE FROM services WHERE tenant_id = $1', [tenantId]);
      await c.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
    await c.end();
  }
});
