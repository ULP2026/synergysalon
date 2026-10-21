/**
 * Tests for the slot engine, run against a stub database.
 *
 * These cover the arithmetic: working hours, overlaps, lead time, closures and
 * daylight saving. They deliberately do not cover the double-booking
 * guarantee, which is a property of Postgres rather than of this code and is
 * tested in booking.integration.test.js against a real database.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';

import { availableSlots } from '../api/_lib/availability.js';
import { DEFAULT_TZ } from '../api/_lib/config.js';

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const SALON_TZ = DEFAULT_TZ;

const TENANT = {
  id: '00000000-0000-0000-0000-0000000000aa',
  slug: 'test',
  name: 'Test Salon',
  timezone: SALON_TZ,
};

const uuid = (n) => `00000000-0000-0000-0000-00000000${String(n).padStart(4, '0')}`;

/**
 * Stands in for a pg client, answering each of the five queries the engine
 * makes by matching on a distinctive fragment of its SQL.
 */
function stubClient({
  duration = 60,
  buffer = 15,
  stylists = [{ id: uuid(1), slug: 'dina', name: 'Dina Lara', title: 'Owner', sort_order: 10 }],
  weekdays = ALL_DAYS,
  opens = '09:00',
  closes = '17:00',
  booked = [],
  timeOff = [],
} = {}) {
  return {
    async query(sql) {
      if (sql.includes('FROM services')) {
        return {
          rows: [{
            id: uuid(99), slug: 'haircuts', name: 'Haircut', category: 'cuts', blurb: '',
            duration_min: duration, buffer_min: buffer, price_cents: null, consult_first: false,
          }],
        };
      }
      if (sql.includes('FROM stylists s')) return { rows: stylists };
      if (sql.includes('FROM stylist_hours')) {
        return {
          rows: stylists.flatMap((s) => weekdays.map((weekday) => ({
            stylist_id: s.id, weekday, starts_at: opens, ends_at: closes,
          }))),
        };
      }
      // starts_at and duration_min, as the engine now asks for them: what
      // blocks another booking is the guest's own time, not upper(during).
      if (sql.includes('FROM appointments')) return { rows: booked };
      if (sql.includes('FROM time_off')) return { rows: timeOff };
      throw new Error(`stub has no answer for: ${sql.slice(0, 60)}`);
    },
  };
}

/** A date far enough ahead that minimum lead time never interferes. */
function futureDate(offsetDays = 30) {
  return DateTime.now().setZone(SALON_TZ).plus({ days: offsetDays }).toISODate();
}

function localTimes(day) {
  return day.slots.map((s) => DateTime.fromISO(s.start).setZone(SALON_TZ).toFormat('HH:mm'));
}

test('offers slots on the configured grid, inside working hours', async () => {
  const date = futureDate();
  const { days } = await availableSlots(stubClient(), TENANT, {
    serviceSlug: 'haircuts', fromDate: date, toDate: date,
  });

  const times = localTimes(days[0]);
  assert.equal(times[0], '09:00');
  assert.equal(times[1], '09:15', 'slots step by SLOT_STEP_MIN');
  // A 60-minute service must have the guest finished by 17:00, so the last
  // start is 16:00 even though clean-down runs past closing.
  assert.equal(times.at(-1), '16:00');
});

test('a booked appointment removes every slot it overlaps', async () => {
  const date = futureDate();
  const from = DateTime.fromISO(`${date}T10:00`, { zone: SALON_TZ });
  const client = stubClient({
    booked: [{ stylist_id: uuid(1), from_ts: from.toJSDate(), duration_min: 60 }],
  });

  const { days } = await availableSlots(client, TENANT, {
    serviceSlug: 'haircuts', fromDate: date, toDate: date,
  });
  const times = localTimes(days[0]);

  // The guest is in the chair from 10:00 to 11:00, and that is what another
  // booking cannot land in. The clean-down either side of it is time the
  // salon schedules, not time it sells, so it holds no slot.
  assert.ok(!times.includes('10:00'), 'the booked time itself is not offered');
  assert.ok(!times.includes('09:15'), '09:15 would run to 10:15 and collide');
  assert.ok(!times.includes('10:45'), '10:45 is still inside it');
  assert.ok(times.includes('09:00'), '09:00 ends at 10:00, as the guest arrives');
  assert.ok(times.includes('11:00'), '11:00 starts as the chair comes free');
});

test('the clean-down is drawn nowhere and holds nobody off', async () => {
  const date = futureDate();
  const from = DateTime.fromISO(`${date}T12:00`, { zone: SALON_TZ });
  const booked = [{ stylist_id: uuid(1), from_ts: from.toJSDate(), duration_min: 60 }];

  const withBuffer = await availableSlots(stubClient({ booked, duration: 60, buffer: 15 }), TENANT, {
    serviceSlug: 'haircuts', fromDate: date, toDate: date,
  });
  const withoutBuffer = await availableSlots(stubClient({ booked, duration: 60, buffer: 0 }), TENANT, {
    serviceSlug: 'haircuts', fromDate: date, toDate: date,
  });

  // 11:00 to 12:00, ending as the 12:00 guest arrives. Whether the service
  // has a clean-down after it makes no difference to whether it is offered:
  // the diary draws no clean-down, and nothing may be refused over time the
  // salon cannot see.
  assert.ok(localTimes(withBuffer.days[0]).includes('11:00'),
    '11:00 finishes exactly as the next guest arrives');
  assert.ok(localTimes(withoutBuffer.days[0]).includes('11:00'),
    'and the same with no clean-down at all');
  assert.ok(!localTimes(withBuffer.days[0]).includes('11:15'),
    '11:15 would run into the booking itself');
});

test('a service exactly as long as a processing break is offered inside it', async () => {
  // The gap of 21 October. A color starts at 10:00 and runs 225 minutes with
  // its Break 90 minutes in: the diary draws the Start to 11:30, Processing
  // open to 12:15, then the Finish. A 45-minute blowout belongs in that hole.
  const date = futureDate();
  const from = DateTime.fromISO(`${date}T10:00`, { zone: SALON_TZ });
  const booked = [{
    stylist_id: uuid(1), from_ts: from.toJSDate(), duration_min: 225, breaks: [[90, 45]],
  }];
  const { days } = await availableSlots(stubClient({ booked, duration: 45, buffer: 10 }), TENANT, {
    serviceSlug: 'haircuts', fromDate: date, toDate: date,
  });
  const times = localTimes(days[0]);

  assert.ok(times.includes('11:30'), '11:30 fills the Break and ends where the Finish starts');
  assert.ok(!times.includes('11:15'), '11:15 would run into the Start');
  assert.ok(!times.includes('11:45'), '11:45 would run into the Finish');
  assert.ok(!times.includes('12:15'), '12:15 is the Finish');
});

test('a salon-wide closure removes the day for everyone', async () => {
  const date = futureDate();
  const client = stubClient({
    stylists: [
      { id: uuid(1), slug: 'dina', name: 'Dina', title: '', sort_order: 10 },
      { id: uuid(2), slug: 'kim', name: 'Kim', title: '', sort_order: 20 },
    ],
    timeOff: [{
      stylist_id: null,
      from_ts: DateTime.fromISO(`${date}T00:00`, { zone: SALON_TZ }).toJSDate(),
      to_ts: DateTime.fromISO(`${date}T23:59`, { zone: SALON_TZ }).toJSDate(),
    }],
  });

  const { days } = await availableSlots(client, TENANT, {
    serviceSlug: 'haircuts', fromDate: date, toDate: date,
  });
  assert.equal(days.length, 0);
});

test('one stylist being off does not close the slot for the other', async () => {
  const date = futureDate();
  const client = stubClient({
    stylists: [
      { id: uuid(1), slug: 'dina', name: 'Dina', title: '', sort_order: 10 },
      { id: uuid(2), slug: 'kim', name: 'Kim', title: '', sort_order: 20 },
    ],
    timeOff: [{
      stylist_id: uuid(1),
      from_ts: DateTime.fromISO(`${date}T00:00`, { zone: SALON_TZ }).toJSDate(),
      to_ts: DateTime.fromISO(`${date}T23:59`, { zone: SALON_TZ }).toJSDate(),
    }],
  });

  const { days } = await availableSlots(client, TENANT, {
    serviceSlug: 'haircuts', fromDate: date, toDate: date,
  });
  assert.equal(days[0].slots[0].stylists.length, 1);
  assert.equal(days[0].slots[0].stylists[0], 'kim');
});

test('closed days produce nothing', async () => {
  // Sunday only in the schema's numbering, then ask for a Monday.
  const monday = DateTime.now().setZone(SALON_TZ).plus({ days: 30 }).startOf('week');
  const client = stubClient({ weekdays: [0] });
  const { days } = await availableSlots(client, TENANT, {
    serviceSlug: 'haircuts', fromDate: monday.toISODate(), toDate: monday.toISODate(),
  });
  assert.equal(days.length, 0);
});

test('minimum lead time hides slots that are too soon', async () => {
  const today = DateTime.now().setZone(SALON_TZ).toISODate();
  const client = stubClient({ opens: '00:00', closes: '23:45' });
  const { days } = await availableSlots(client, TENANT, {
    serviceSlug: 'haircuts', fromDate: today, toDate: today,
  });

  const earliest = days.flatMap((d) => d.slots)
    .map((s) => DateTime.fromISO(s.start))
    .sort((a, b) => a - b)[0];
  if (earliest) {
    const minutesAway = earliest.diff(DateTime.now(), 'minutes').minutes;
    assert.ok(minutesAway >= 119, `earliest slot is ${Math.round(minutesAway)} minutes away`);
  }
});

test('the past is never offered', async () => {
  const yesterday = DateTime.now().setZone(SALON_TZ).minus({ days: 1 }).toISODate();
  const { days } = await availableSlots(stubClient(), TENANT, {
    serviceSlug: 'haircuts', fromDate: yesterday, toDate: yesterday,
  });
  assert.equal(days.length, 0);
});

test('rescheduling ignores the appointment being moved', async () => {
  const date = futureDate();
  const from = DateTime.fromISO(`${date}T10:00`, { zone: SALON_TZ });
  const booked = [{ stylist_id: uuid(1), from_ts: from.toJSDate(), duration_min: 60 }];

  // The stub ignores the exclusion parameter, so emulate the real query by
  // handing back an empty busy set when an id is excluded.
  const client = stubClient({ booked });
  const withExclusion = {
    async query(sql, params) {
      if (sql.includes('FROM appointments') && params?.[2]) return { rows: [] };
      return client.query(sql, params);
    },
  };

  const before = await availableSlots(client, TENANT, {
    serviceSlug: 'haircuts', fromDate: date, toDate: date,
  });
  const after = await availableSlots(withExclusion, TENANT, {
    serviceSlug: 'haircuts', fromDate: date, toDate: date,
    excludeAppointmentId: '00000000-0000-0000-0000-000000000001',
  });

  assert.ok(!localTimes(before.days[0]).includes('10:00'));
  assert.ok(localTimes(after.days[0]).includes('10:00'),
    'the guest can move their own booking onto its own time');
});

test('slots stay on the salon clock across a daylight saving change', async () => {
  // US clocks go back on 1 November 2026; 4 November is firmly after it.
  const client = stubClient();
  const { days } = await availableSlots(client, TENANT, {
    serviceSlug: 'haircuts', fromDate: '2026-11-04', toDate: '2026-11-04',
  });

  if (days.length) {
    const first = DateTime.fromISO(days[0].slots[0].start).setZone(SALON_TZ);
    assert.equal(first.toFormat('HH:mm'), '09:00', 'still opens at 09:00 local');
    assert.equal(first.offset, -300, 'and is on EST (-05:00), not EDT');
  }
});
