/**
 * The salon's opening hours (salon-hours.js), from the PMC: the day view
 * shows only these, and no shift is sold outside them.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { SALON_HOURS, clampShifts, clampSpans, salonHoursOn } from '../api/_lib/salon-hours.js';

const synergy = { slug: 'synergy' };

test("Synergy's hours are the PMC's, and Sunday is closed", () => {
  assert.equal(salonHoursOn(synergy, 0), null);
  assert.deepEqual(salonHoursOn(synergy, 1), [540, 900]);   // Mon 9 to 3
  assert.deepEqual(salonHoursOn(synergy, 2), [540, 900]);   // Tue 9 to 3
  assert.deepEqual(salonHoursOn(synergy, 3), [540, 1140]);  // Wed 9 to 7
  assert.deepEqual(salonHoursOn(synergy, 4), [540, 1140]);  // Thu 9 to 7
  assert.deepEqual(salonHoursOn(synergy, 5), [540, 1080]);  // Fri 9 to 6
  assert.deepEqual(salonHoursOn(synergy, 6), [540, 900]);   // Sat 9 to 3
});

test('a salon with no hours on record keeps its stylists’ shifts as they are', () => {
  assert.equal(salonHoursOn({ slug: 'zz-nobody' }, 1), undefined);
  const shifts = [{ starts_at: '07:00:00', ends_at: '21:00:00' }];
  assert.equal(clampShifts(shifts, undefined), shifts);
  assert.deepEqual(clampSpans([[420, 1260]], undefined), [[420, 1260]]);
});

test('shifts are cut to the salon’s day, and a closed day leaves none', () => {
  const open = salonHoursOn(synergy, 1);
  assert.deepEqual(
    clampShifts([{ weekday: 1, starts_at: '08:00:00', ends_at: '17:30:00' }], open),
    [{ weekday: 1, starts_at: '09:00', ends_at: '15:00' }],
  );
  assert.deepEqual(clampShifts([{ starts_at: '10:00', ends_at: '12:00' }], open),
    [{ starts_at: '10:00', ends_at: '12:00' }]);
  // Wholly after closing: gone.
  assert.deepEqual(clampShifts([{ starts_at: '16:00', ends_at: '20:00' }], open), []);
  assert.deepEqual(clampShifts([{ starts_at: '09:00', ends_at: '15:00' }], null), []);
  assert.deepEqual(clampSpans([[480, 1020], [1000, 1100]], open), [[540, 900]]);
  assert.deepEqual(clampSpans([[540, 900]], null), []);
});

test('every weekday is listed for Synergy', () => {
  assert.deepEqual(Object.keys(SALON_HOURS.synergy).map(Number), [0, 1, 2, 3, 4, 5, 6]);
});
