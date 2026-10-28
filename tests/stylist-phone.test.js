/**
 * A stylist's mobile number is required (asked for 2026-10-28): Karen knows
 * a text is from a stylist, and lets them move or cancel their clients'
 * appointments, only by the number on their team profile.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { assertStylistPhone } from '../api/staff/_routes/profile.js';

test('a stylist needs a ten-digit mobile; other roles may leave it empty', () => {
  assert.throws(() => assertStylistPhone('stylist', ''), /A stylist needs a mobile number/);
  assert.throws(() => assertStylistPhone('stylist', '555-0177'), /area code/);
  assert.doesNotThrow(() => assertStylistPhone('stylist', '(813) 555-0177'));
  assert.doesNotThrow(() => assertStylistPhone('stylist', '+1 813 555 0177'));
  for (const role of ['owner', 'admin', 'manager', 'front_desk']) assert.doesNotThrow(() => assertStylistPhone(role, ''));
});
