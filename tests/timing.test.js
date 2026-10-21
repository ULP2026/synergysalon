/**
 * How long a service takes with the stylist doing it, and which parts of it
 * they are working (api/_lib/timing.js). No database needed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { combineServices } from '../api/_lib/availability.js';
import { cleanBreaks, cleanDown, timedService, timingKey, workSpans } from '../api/_lib/timing.js';

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
  // Single Process Color: their parts, the Break never under the salon's 45.
  assert.deepEqual(
    [timedService(single, mine).duration_min, timedService(single, mine).breaks],
    [40 + 45 + 30, [[40, 45]]],
  );
  // Color & Cut: their cut, then the color's parts; the Break is never
  // shorter than the salon's 45.
  assert.deepEqual(
    [timedService(colorCut, mine).duration_min, timedService(colorCut, mine).breaks],
    [45 + 40 + 45 + 30, [[85, 45]]],
  );
  // Any other kind: their own single figure.
  assert.equal(timedService(haircut, mine).duration_min, 45);
  assert.deepEqual(timedService(haircut, mine).breaks, []);
});

test('Color & Cut with nothing typed is the salon\'s 45/45/45/45, the stylist free while it processes', () => {
  const visit = timedService(colorCut, {});
  assert.equal(visit.duration_min, 180);
  assert.deepEqual(visit.breaks, [[90, 45]]);
  // Cut 0-45, apply 45-90, processing 90-135 (free), finish 135-180.
  assert.deepEqual(workSpans({ durationMin: 180, bufferMin: 0, breaks: visit.breaks }), [[0, 90], [135, 180]]);
  // A longer processing time is kept; only the cut typed, the color is the salon's.
  assert.deepEqual(timedService(colorCut, { color: { start: 45, break: 60, finish: 45 } }).breaks, [[90, 60]]);
  assert.deepEqual(timedService(colorCut, { cuts: { duration: 30 } }).breaks, [[75, 45]]);
});

test('Single Process Color with nothing typed is 45/45/45, the stylist free while it processes', () => {
  for (const details of [{}, { color: { duration: 75 } }, { color: { start: 30, break: 20 } }]) {
    const visit = timedService(single, details);
    assert.equal(visit.duration_min, 135);
    assert.deepEqual(visit.breaks, [[45, 45]]);
  }
  assert.deepEqual(workSpans({ durationMin: 135, bufferMin: 0, breaks: [[45, 45]] }), [[0, 45], [90, 135]]);
});

test('nothing typed, or half a timing, falls back to the services table', () => {
  assert.equal(timedService(balayage, {}).duration_min, 180);
  assert.equal(timedService(haircut, { cuts: { on: true, duration: null } }).duration_min, 60);
  const gloss = svc('gloss-or-toner', 'Gloss or Toner', 'color', 45);
  // A Break with no Finish is not a timing: guessing its end would sell time.
  assert.equal(timedService(gloss, { color: { start: 30, break: 20 } }).duration_min, 45);
  // A color length saved before the parts existed is still used.
  assert.equal(timedService(gloss, { color: { duration: 75 } }).duration_min, 75);
  assert.deepEqual(timedService(gloss, { color: { duration: 75 } }).breaks, []);
});

test('several services: lengths, breaks and clean-downs add up end to end', () => {
  // A 45-minute cut, its 10-minute clean-down, then a balayage whose Break
  // starts 60 minutes into it: 45 + 10 + 60 = 115 minutes from the start.
  const visit = combineServices(timedService(haircut, mine), [timedService(balayage, mine)]);
  assert.equal(visit.durationMin, 45 + 10 + 155);
  assert.equal(visit.bufferMin, 15);
  assert.deepEqual(visit.breaks, [[115, 45]]);
  // Picked the other way round, the cut still goes first.
  const back = combineServices(timedService(balayage, mine), [timedService(haircut, mine)]);
  assert.deepEqual(back.names, ['Haircut', 'Balayage']);
  assert.equal(back.durationMin, 45 + 10 + 155);
  assert.deepEqual(back.breaks, [[115, 45]]);
});

test('a stylist works the guest time with its breaks cut out, turnaround apart', () => {
  const visit = { durationMin: 155, bufferMin: 15, breaks: [[60, 45]] };
  assert.deepEqual(workSpans(visit), [[0, 60], [105, 155]]);
  assert.deepEqual(cleanDown(visit), [[155, 170]]);
  // The two are asked for separately because availability.js counts the
  // second one against some things and not others.
  assert.deepEqual(workSpans({ durationMin: 60, bufferMin: 10, breaks: [] }), [[0, 60]]);
  assert.deepEqual(cleanDown({ durationMin: 60, bufferMin: 0 }), [], 'no turnaround, no span');
});

test('a service exactly as long as a processing break fits inside it', () => {
  // The 21 October gap: a colour Break running from 90 to 135 minutes in,
  // and a 45-minute service offered at 90. Its own time has to fit the hole
  // exactly, or the salon is looking at 45 free minutes it cannot sell.
  const colour = workSpans({ durationMin: 225, bufferMin: 15, breaks: [[90, 45]] });
  assert.deepEqual(colour, [[0, 90], [135, 225]]);
  const blowout = workSpans({ durationMin: 45, bufferMin: 10, breaks: [] });
  assert.deepEqual(blowout, [[0, 45]]);
  // Shifted to 90 minutes in: 90 to 135, ending where the Finish begins.
  // Touching is not overlapping.
  const [from, to] = [90 + blowout[0][0], 90 + blowout[0][1]];
  assert.deepEqual([from, to], [90, 135]);
  assert.ok(!colour.some(([a, b]) => from < b && to > a), 'it sits in the Break');
  // Its turnaround does run into the Finish, which is why the rule that
  // ignores it is the narrow one in availability.js and not this file.
  const [tail] = cleanDown({ durationMin: 45, bufferMin: 10 });
  assert.deepEqual([90 + tail[0], 90 + tail[1]], [135, 145]);
});

test('breaks the database is given are whole minutes inside the visit', () => {
  assert.deepEqual(cleanBreaks([[60, 45], [0, 10], [150, 30], ['x', 5]], 160), [[60, 45]]);
  assert.deepEqual(cleanBreaks(null, 60), []);
});
