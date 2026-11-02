/**
 * The salon's working day is its team's hours (salon-hours.js): from the
 * earliest anyone starts to the latest anyone finishes, a day nobody works
 * closed, and no week at all while nobody has hours.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { daySpan, salonWeek } from '../api/_lib/salon-hours.js';

test('the day runs from the earliest start to the latest finish', () => {
  assert.deepEqual(daySpan([[540, 1080]]), [540, 1080]);            // 9 to 6
  assert.deepEqual(daySpan([[600, 900], [540, 780], [720, 1140]]), [540, 1140]);
  assert.equal(daySpan([]), null);
  assert.equal(daySpan(undefined), null);
});

const fakeDb = (rows) => ({ query: async () => ({ rows }) });

test('Monday 9 to 6 and Tuesday 9 to 3 give exactly those days, and a day nobody works is closed', async () => {
  const week = await salonWeek(fakeDb([
    { weekday: 1, opens: '09:00', closes: '18:00' },
    { weekday: 2, opens: '09:00', closes: '15:00' },
    { weekday: 2, opens: '10:00', closes: '14:00' },
  ]), 'zz');
  assert.deepEqual(week[1], [540, 1080]);
  assert.deepEqual(week[2], [540, 900]);
  assert.equal(week[0], null);
  assert.equal(week[3], null);
});

test('a salon with no hours set yet has no week, so it is not shown closed every day', async () => {
  assert.equal(await salonWeek(fakeDb([]), 'zz'), null);
});
