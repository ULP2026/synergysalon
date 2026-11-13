/**
 * Every color service timed in its own Start, Break and Finish, and "No
 * break" (Luis, 2026-11-13). A service's own parts beat its kind's figures;
 * "No break" is one block with no processing gap, and the salon's minimum
 * 45-minute break for Single Process does not force one back in. The team's
 * form keeps both, and refuses a Break with nothing around it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { servicesFrom } from '../api/staff/_routes/profile.js';
import { ownTiming } from '../api/_lib/timing.js';

const single = { slug: 'single-process', name: 'Single Process Color', category: 'color' };
const balayage = { slug: 'balayage', name: 'Balayage', category: 'color' };
const partial = { slug: 'partial-highlights', name: 'Partial Highlights', category: 'color' };

test('a color service\'s own parts beat the Color row', () => {
  const d = { color: { start: 45, break: 45, finish: 45 }, items: { 'single-process': { start: 30, break: 20, finish: 25 } } };
  assert.deepEqual(ownTiming(d, single), { durationMin: 75, breaks: [[30, 20]] });
});

test('left empty, a color service is timed by its kind as before', () => {
  const d = { color: { start: 40, break: 50, finish: 40, highlights: { start: 60, break: 45, finish: 45 } } };
  assert.deepEqual(ownTiming(d, balayage), { durationMin: 150, breaks: [[60, 45]] });
});

test('No break is one block, even for Single Process', () => {
  const d = { color: { start: 45, break: 45, finish: 45 }, items: { 'single-process': { noBreak: true, duration: 90 } } };
  assert.deepEqual(ownTiming(d, single), { durationMin: 90, breaks: [] });
  const k = { color: { start: 45, break: 0, finish: 45, partial: { noBreak: true, duration: 60 } } };
  assert.deepEqual(ownTiming(k, partial), { durationMin: 60, breaks: [] }, 'on a row of the kind too');
});

test('the team form keeps a service\'s parts and No break', () => {
  const s = servicesFrom({
    color: { on: true, start: 45, break: 45, finish: 45, partial: { noBreak: true, duration: 60 } },
    items: {
      'single-process': { on: true, price: 69, start: 30, break: 20, finish: 25 },
      balayage: { on: true, noBreak: true, duration: 120 },
    },
  });
  assert.deepEqual(s.color.partial, { noBreak: true, duration: 60 });
  assert.deepEqual(s.items['single-process'], { on: true, duration: null, price: 69, start: 30, break: 20, finish: 25 });
  assert.deepEqual(s.items.balayage, { on: true, duration: 120, noBreak: true });
  assert.throws(() => servicesFrom({ items: { balayage: { break: 30 } } }), /Start and a Finish around its Break/);
});
