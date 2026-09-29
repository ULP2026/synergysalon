/**
 * Stylists' hours come from CENTRO: reading its answer, turning slot starts
 * into free windows, and the staff pass that lets the paused popup be tested.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { fitsIn, mergeWindows } from '../api/_lib/centro-hours.js';
import { parseFreeSlots, slotMinutes } from '../api/_lib/ghl.js';
import { mintPreview, previewAllowed } from '../api/_lib/preview.js';

const at = (iso) => Date.parse(iso);

test('CENTRO free slots are read from the date map it returns', () => {
  const got = parseFreeSlots({
    '2026-10-03': { slots: ['2026-10-03T10:00:00-04:00', '2026-10-03T10:30:00-04:00'] },
    '2026-10-05': { slots: [{ slot: '2026-10-05T12:00:00-04:00' }] },
    traceId: 'abc',
  });
  assert.deepEqual(got, [
    at('2026-10-03T10:00:00-04:00'), at('2026-10-03T10:30:00-04:00'), at('2026-10-05T12:00:00-04:00'),
  ]);
  assert.deepEqual(parseFreeSlots({ _dates_: { '2026-10-03': { slots: ['2026-10-03T09:00:00-04:00'] } } }),
    [at('2026-10-03T09:00:00-04:00')]);
  assert.deepEqual(parseFreeSlots({ traceId: 'x' }), []);
});

test('slot length is read in minutes or hours', () => {
  assert.equal(slotMinutes({ slotDuration: 30, slotDurationUnit: 'mins' }), 30);
  assert.equal(slotMinutes({ slotDuration: 1, slotDurationUnit: 'hours' }), 60);
  assert.equal(slotMinutes({}), 30);
});

test('a service fits only inside time CENTRO says is free', () => {
  // Free 10:00 to 12:00 (four 30-minute slots), then 14:00 to 14:30.
  const w = mergeWindows([
    at('2026-10-03T10:00:00-04:00'), at('2026-10-03T10:30:00-04:00'),
    at('2026-10-03T11:00:00-04:00'), at('2026-10-03T11:30:00-04:00'),
    at('2026-10-03T14:00:00-04:00'),
  ], 30);
  assert.equal(w.length, 2);
  // 9 AM: the stylist is not there.
  assert.equal(fitsIn(w, at('2026-10-03T09:00:00-04:00'), at('2026-10-03T10:00:00-04:00')), false);
  // 10:30 for 90 minutes ends at noon: fits.
  assert.equal(fitsIn(w, at('2026-10-03T10:30:00-04:00'), at('2026-10-03T12:00:00-04:00')), true);
  // 11:30 for an hour runs into the gap: does not.
  assert.equal(fitsIn(w, at('2026-10-03T11:30:00-04:00'), at('2026-10-03T12:30:00-04:00')), false);
});

test('a staff test pass works for its salon, and only until it expires', () => {
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = saved || 'postgres://test-only';
  try {
    const now = Date.now();
    const pass = mintPreview('tenant-a', now);
    const req = (v) => ({ headers: { 'x-booking-preview': v } });
    assert.equal(previewAllowed(req(pass), { id: 'tenant-a' }, now), true);
    assert.equal(previewAllowed(req(pass), { id: 'tenant-b' }, now), false);
    assert.equal(previewAllowed(req(pass), { id: 'tenant-a' }, now + 13 * 3600 * 1000), false);
    assert.equal(previewAllowed(req(`${pass.split('.')[0]}.forged`), { id: 'tenant-a' }, now), false);
    assert.equal(previewAllowed({ headers: {} }, { id: 'tenant-a' }, now), false);
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved;
  }
});
