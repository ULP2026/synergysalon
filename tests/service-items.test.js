/**
 * Each service inside a kind (asked for 2026-11-02): whether a person offers
 * it and how long it takes them. Kept by servicesFrom, and its minutes beat
 * the kind's own figure when a visit is timed (timing.js).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { servicesFrom } from '../api/staff/_routes/profile.js';
import { ownTiming, timedService } from '../api/_lib/timing.js';

test('each service keeps whether it is offered and its own minutes', () => {
  const out = servicesFrom({
    cuts: { on: true, duration: 60 },
    items: { haircut: { on: true, duration: '30' }, 'bang-trim': { on: false }, 'BAD SLUG': { on: false }, x: 'nope' },
  });
  assert.deepEqual(out.items, { haircut: { on: true, duration: 30 }, 'bang-trim': { on: false, duration: null } });
  assert.deepEqual(servicesFrom({ cuts: { on: true } }).items, {}, 'nothing typed, nothing kept');
  assert.throws(() => servicesFrom({ items: { haircut: { on: true, duration: 2 } } }), /5 to 720/);
});

const cut = { slug: 'haircut', name: 'Haircut', category: 'cuts', duration_min: 45, price_cents: null };

test("a service's own minutes beat the kind's, which beat the menu's", () => {
  assert.equal(ownTiming({ cuts: { duration: 60 }, items: { haircut: { duration: 30 } } }, cut).durationMin, 30);
  assert.equal(ownTiming({ cuts: { duration: 60 } }, cut).durationMin, 60);
  assert.equal(ownTiming({}, cut), null);
  assert.equal(timedService(cut, {}).duration_min, 45);
  assert.equal(timedService(cut, { items: { haircut: { duration: 20 } } }).duration_min, 20);
});

test("a color timed on its own keeps the kind's processing break when it still fits", () => {
  const color = { slug: 'single-process', name: 'Single Process Color', category: 'color', duration_min: 90 };
  const details = { color: { start: 45, break: 45, finish: 45 } };
  assert.deepEqual(ownTiming({ ...details, items: { 'single-process': { duration: 150 } } }, color),
    { durationMin: 150, breaks: [[45, 45]] });
  assert.deepEqual(ownTiming({ ...details, items: { 'single-process': { duration: 60 } } }, color),
    { durationMin: 60, breaks: [] }, 'too short for the break: none');
});
