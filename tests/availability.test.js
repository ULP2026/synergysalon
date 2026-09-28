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
import { SALON_TZ } from '../api/_lib/config.js';

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * Stands in for a pg client, answering each of the five queries the engine
 * makes by matching on a distinctive fragment of its SQL.
 */
function stubClient({
  duration = 60,
  buffer = 15,
  stylists = [{ id: 'dina', name: 'Dina Lara', title: 'Owner', sort_order: 10 }],
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
            id: 'haircuts', name: 'Haircut', category: 'cuts', blurb: '',
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
  const { days } = await availableSlots(stubClient(), {
    serviceId: 'haircuts', fromDate: date, toDate: date,
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
    booked: [{
      stylist_id: 'dina',
      from_ts: from.toJSDate(),
      to_ts: from.plus({ minutes: 75 }).toJSDate(),   // 60 service + 15 buffer
    }],
  });

  const { days } = await availableSlots(client, {
    serviceId: 'haircuts', fromDate: date, toDate: date,
  });
  const times = localTimes(days[0]);

  // The booking blocks 10:00-11:15. A new appointment needs 75 minutes of
  // diary (60 in the chair, 15 to turn the station round), so the latest
  // start that would clear it is 08:45 — before the salon opens. The whole
  // morning is therefore gone, which is correct and not obvious.
  assert.ok(!times.includes('10:00'), 'the booked time itself is not offered');
  assert.ok(!times.includes('09:00'), '09:00 would run to 10:15 and collide');
  assert.equal(times[0], '11:15', 'the first free start is the end of the buffer');
});

test('the buffer blocks the diary but is not part of the appointment', async () => {
  const date = futureDate();
  const from = DateTime.fromISO(`${date}T12:00`, { zone: SALON_TZ });
  const booked = [{
    stylist_id: 'dina',
    from_ts: from.toJSDate(),
    to_ts: from.plus({ minutes: 60 }).toJSDate(),
  }];

  const withBuffer = await availableSlots(stubClient({ booked, duration: 60, buffer: 15 }), {
    serviceId: 'haircuts', fromDate: date, toDate: date,
  });
  const withoutBuffer = await availableSlots(stubClient({ booked, duration: 60, buffer: 0 }), {
    serviceId: 'haircuts', fromDate: date, toDate: date,
  });

  assert.ok(!localTimes(withBuffer.days[0]).includes('11:00'),
    'with clean-down, 11:00 would run into the 12:00 booking');
  assert.ok(localTimes(withoutBuffer.days[0]).includes('11:00'),
    'without clean-down, 11:00 finishes exactly as the next guest arrives');
});

test('a salon-wide closure removes the day for everyone', async () => {
  const date = futureDate();
  const client = stubClient({
    stylists: [
      { id: 'dina', name: 'Dina', title: '', sort_order: 10 },
      { id: 'kim', name: 'Kim', title: '', sort_order: 20 },
    ],
    timeOff: [{
      stylist_id: null,
      from_ts: DateTime.fromISO(`${date}T00:00`, { zone: SALON_TZ }).toJSDate(),
      to_ts: DateTime.fromISO(`${date}T23:59`, { zone: SALON_TZ }).toJSDate(),
    }],
  });

  const { days } = await availableSlots(client, {
    serviceId: 'haircuts', fromDate: date, toDate: date,
  });
  assert.equal(days.length, 0);
});

test('one stylist being off does not close the slot for the other', async () => {
  const date = futureDate();
  const client = stubClient({
    stylists: [
      { id: 'dina', name: 'Dina', title: '', sort_order: 10 },
      { id: 'kim', name: 'Kim', title: '', sort_order: 20 },
    ],
    timeOff: [{
      stylist_id: 'dina',
      from_ts: DateTime.fromISO(`${date}T00:00`, { zone: SALON_TZ }).toJSDate(),
      to_ts: DateTime.fromISO(`${date}T23:59`, { zone: SALON_TZ }).toJSDate(),
    }],
  });

  const { days } = await availableSlots(client, {
    serviceId: 'haircuts', fromDate: date, toDate: date,
  });
  assert.equal(days[0].slots[0].stylists.length, 1);
  assert.equal(days[0].slots[0].stylists[0], 'kim');
});

test('closed days produce nothing', async () => {
  // Sunday only in the schema's numbering, then ask for a Monday.
  const monday = DateTime.now().setZone(SALON_TZ).plus({ days: 30 }).startOf('week');
  const client = stubClient({ weekdays: [0] });
  const { days } = await availableSlots(client, {
    serviceId: 'haircuts', fromDate: monday.toISODate(), toDate: monday.toISODate(),
  });
  assert.equal(days.length, 0);
});

test('minimum lead time hides slots that are too soon', async () => {
  const today = DateTime.now().setZone(SALON_TZ).toISODate();
  const client = stubClient({ opens: '00:00', closes: '23:45' });
  const { days } = await availableSlots(client, {
    serviceId: 'haircuts', fromDate: today, toDate: today,
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
  const { days } = await availableSlots(stubClient(), {
    serviceId: 'haircuts', fromDate: yesterday, toDate: yesterday,
  });
  assert.equal(days.length, 0);
});

test('rescheduling ignores the appointment being moved', async () => {
  const date = futureDate();
  const from = DateTime.fromISO(`${date}T10:00`, { zone: SALON_TZ });
  const booked = [{
    stylist_id: 'dina',
    from_ts: from.toJSDate(),
    to_ts: from.plus({ minutes: 75 }).toJSDate(),
  }];

  // The stub ignores the exclusion parameter, so emulate the real query by
  // handing back an empty busy set when an id is excluded.
  const client = stubClient({ booked });
  const withExclusion = {
    async query(sql, params) {
      if (sql.includes('FROM appointments') && params?.[2]) return { rows: [] };
      return client.query(sql, params);
    },
  };

  const before = await availableSlots(client, {
    serviceId: 'haircuts', fromDate: date, toDate: date,
  });
  const after = await availableSlots(withExclusion, {
    serviceId: 'haircuts', fromDate: date, toDate: date,
    excludeAppointmentId: '00000000-0000-0000-0000-000000000001',
  });

  assert.ok(!localTimes(before.days[0]).includes('10:00'));
  assert.ok(localTimes(after.days[0]).includes('10:00'),
    'the guest can move their own booking onto its own time');
});

test('slots stay on the salon clock across a daylight saving change', async () => {
  // US clocks go back on 1 November 2026; 4 November is firmly after it.
  const client = stubClient();
  const { days } = await availableSlots(client, {
    serviceId: 'haircuts', fromDate: '2026-11-04', toDate: '2026-11-04',
  });

  if (days.length) {
    const first = DateTime.fromISO(days[0].slots[0].start).setZone(SALON_TZ);
    assert.equal(first.toFormat('HH:mm'), '09:00', 'still opens at 09:00 local');
    assert.equal(first.offset, -300, 'and is on EST (-05:00), not EDT');
  }
});
