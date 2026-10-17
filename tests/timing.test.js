/**
 * How long a service takes with the stylist doing it, and which parts of it
 * they are working (api/_lib/timing.js). No database needed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { combineServices } from '../api/_lib/availability.js';
import { cleanBreaks, timedService, timingKey, workSpans } from '../api/_lib/timing.js';

const svc = (slug, name, category, duration, buffer = 15) => ({
  slug, name, category, duration_min: duration, buffer_min: buffer, price_cents: null,
});
const balayage = svc('balayage', 'Balayage', 'color', 180);
const single = svc('single-process-color', 'Single Process Color', 'color', 90);
const colorCut = svc('color-and-cut', 'Color & Cut', 'color', 180);
const haircut = svc('haircuts', 'Haircut', 'cuts', 60, 10);

const mine = {
  color: { on: true, start: 40, break: 35, finish: 30, highlights: { start: 60, break: 45, finish: 50 } },
  cuts: { on: true, duration: 45 },
};

test('highlights, balayage and foils are timed by the Highlights figures; other color by Color', () => {
  assert.equal(timingKey(balayage), 'highlights');
  assert.equal(timingKey(svc('highlights-and-foils', 'Highlights & Foils', 'color', 150)), 'highlights');
  assert.equal(timingKey(single), 'color');
  assert.equal(timingKey(haircut), 'cuts');
});

test("a stylist's Start, Break and Finish are the service's length, with the Break inside it", () => {
  assert.deepEqual(
    [timedService(balayage, mine).duration_min, timedService(balayage, mine).breaks],
    [155, [[60, 45]]],
  );
  assert.deepEqual(
    [timedService(single, mine).duration_min, timedService(single, mine).breaks],
    [105, [[40, 35]]],
  );
  // Color & Cut: the color's parts, then their cut.
  assert.deepEqual(
    [timedService(colorCut, mine).duration_min, timedService(colorCut, mine).breaks],
    [150, [[40, 35]]],
  );
  // Any other kind: their own single figure.
  assert.equal(timedService(haircut, mine).duration_min, 45);
  assert.deepEqual(timedService(haircut, mine).breaks, []);
});

test('nothing typed, or half a timing, falls back to the services table', () => {
  assert.equal(timedService(balayage, {}).duration_min, 180);
  assert.equal(timedService(haircut, { cuts: { on: true, duration: null } }).duration_min, 60);
  // A Break with no Finish is not a timing: guessing its end would sell time.
  assert.equal(timedService(single, { color: { start: 30, break: 20 } }).duration_min, 90);
  // A color length saved before the parts existed is still used.
  assert.equal(timedService(single, { color: { duration: 75 } }).duration_min, 75);
  assert.deepEqual(timedService(single, { color: { duration: 75 } }).breaks, []);
});

test('several services: lengths, breaks and clean-downs add up end to end', () => {
  // A 45-minute cut, its 10-minute clean-down, then a balayage whose Break
  // starts 60 minutes into it: 45 + 10 + 60 = 115 minutes from the start.
  const visit = combineServices(timedService(haircut, mine), [timedService(balayage, mine)]);
  assert.equal(visit.durationMin, 45 + 10 + 155);
  assert.equal(visit.bufferMin, 15);
  assert.deepEqual(visit.breaks, [[115, 45]]);
  // The other way round, the Break is where the balayage puts it.
  const back = combineServices(timedService(balayage, mine), [timedService(haircut, mine)]);
  assert.equal(back.durationMin, 155 + 15 + 45);
  assert.deepEqual(back.breaks, [[60, 45]]);
});

test('the stylist works the visit with its breaks cut out; the clean-down blocks the diary only', () => {
  const visit = { durationMin: 155, bufferMin: 15, breaks: [[60, 45]] };
  assert.deepEqual(workSpans(visit), [[0, 60], [105, 170]]);
  assert.deepEqual(workSpans(visit, false), [[0, 60], [105, 155]]);
  assert.deepEqual(workSpans({ durationMin: 60, bufferMin: 10, breaks: [] }), [[0, 70]]);
});

test('breaks the database is given are whole minutes inside the visit', () => {
  assert.deepEqual(cleanBreaks([[60, 45], [0, 10], [150, 30], ['x', 5]], 160), [[60, 45]]);
  assert.deepEqual(cleanBreaks(null, 60), []);
});
