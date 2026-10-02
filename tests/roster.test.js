/**
 * Weekly hours are typed by a salon owner on a phone, so the parsing is where
 * the damage happens: a shift that ends before it starts, two shifts that
 * overlap, a day that does not exist. Each one of those, stored, is a booking
 * page that offers times nobody is there for.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readHours } from '../api/_lib/roster.js';

const ok = (rows) => readHours(rows);
const fails = (rows, re) => assert.throws(() => readHours(rows), re);

test('not submitting hours is not the same as clearing them', () => {
  assert.equal(readHours(undefined), null);
  assert.equal(readHours(null), null);
  // An empty list is a real answer: they work no fixed hours.
  assert.deepEqual(readHours([]), []);
});

test('a normal week comes back sorted', () => {
  const out = ok([
    { weekday: 3, starts: '09:00', ends: '19:00' },
    { weekday: 1, starts: '09:00', ends: '15:00' },
    { weekday: 1, starts: '16:00', ends: '18:00' },
  ]);
  assert.deepEqual(out.map((h) => `${h.weekday} ${h.starts}-${h.ends}`), [
    '1 09:00-15:00', '1 16:00-18:00', '3 09:00-19:00',
  ]);
});

test('a shift must end after it starts', () => {
  fails([{ weekday: 2, starts: '17:00', ends: '09:00' }], /end after it starts/);
  fails([{ weekday: 2, starts: '09:00', ends: '09:00' }], /end after it starts/);
});

test('two shifts on one day may not overlap', () => {
  fails([
    { weekday: 4, starts: '09:00', ends: '13:00' },
    { weekday: 4, starts: '12:00', ends: '17:00' },
  ], /overlap/);
  // Touching is fine: straight through from one into the next.
  ok([
    { weekday: 4, starts: '09:00', ends: '13:00' },
    { weekday: 4, starts: '13:00', ends: '17:00' },
  ]);
  // The same clock times on different days are not an overlap.
  ok([
    { weekday: 4, starts: '09:00', ends: '13:00' },
    { weekday: 5, starts: '09:00', ends: '13:00' },
  ]);
});

test('only real days and real times', () => {
  fails([{ weekday: 7, starts: '09:00', ends: '17:00' }], /day that does not exist/);
  fails([{ weekday: -1, starts: '09:00', ends: '17:00' }], /day that does not exist/);
  fails([{ weekday: 1.5, starts: '09:00', ends: '17:00' }], /day that does not exist/);
  fails([{ weekday: 1, starts: '9am', ends: '5pm' }], /look like 09:00/);
  fails([{ weekday: 1, starts: '24:00', ends: '25:00' }], /look like 09:00/);
  fails([{ weekday: 1, starts: '09:60', ends: '17:00' }], /look like 09:00/);
  fails([{ weekday: 1, starts: '', ends: '17:00' }], /look like 09:00/);
});

test('a rota, not a typo', () => {
  fails([
    { weekday: 2, starts: '08:00', ends: '09:00' },
    { weekday: 2, starts: '10:00', ends: '11:00' },
    { weekday: 2, starts: '12:00', ends: '13:00' },
    { weekday: 2, starts: '14:00', ends: '15:00' },
  ], /too many shifts in one day/);
  fails(Array.from({ length: 22 }, (_, i) => (
    { weekday: i % 7, starts: '09:00', ends: '10:00' })), /too many shifts/);
});

test('rubbish in place of a list is refused, not coerced', () => {
  fails('09:00-17:00', /not valid/);
  fails({ monday: '9-5' }, /not valid/);
  fails([null], /day that does not exist/);
});
