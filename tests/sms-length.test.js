/**
 * Texts cost by the segment: one is the default, two only when necessary
 * (2026-10-31). No database or network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { fitText, segments, toGsm } from '../api/_lib/sms-length.js';
import { appointmentText } from '../api/_lib/sms-notify.js';

test('segments are counted as the carriers bill them', () => {
  assert.equal(segments('a'.repeat(160)), 1);
  assert.equal(segments('a'.repeat(161)), 2);
  assert.equal(segments('a'.repeat(306)), 2);
  assert.equal(segments('a'.repeat(307)), 3);
  // One character outside the plain alphabet: 70 a segment.
  assert.equal(segments(`${'a'.repeat(70)}’`), 2);
  // The extension set costs two each.
  assert.equal(segments('€'.repeat(80)), 1);
  assert.equal(segments('€'.repeat(81)), 2);
});

test('every text is put into the plain alphabet', () => {
  assert.equal(toGsm('Women’s Cut — “today”… 💇'), 'Women\'s Cut - "today"... ');
  // ö, Å and é are in the alphabet and stay; ë is not and loses its accent.
  assert.equal(toGsm('Zoë Ångström José'), 'Zoe Ångström José');
  assert.equal(segments(toGsm(`${'a'.repeat(150)}’s`)), 1);
});

test('the fullest wording that fits one segment wins; two only when none does', () => {
  assert.equal(fitText(['b'.repeat(200), 'b'.repeat(150), 'b'.repeat(100)]), 'b'.repeat(150));
  assert.equal(fitText(['b'.repeat(400), 'b'.repeat(250), 'b'.repeat(200)]), 'b'.repeat(250));
});

test('appointment texts fit one segment for ordinary visits, even with long names', () => {
  const tenant = { name: 'Synergy Salon', timezone: 'America/New_York', phone: '813.654.2055' };
  const appt = {
    starts_at: new Date(Date.now() + 6 * 864e5).toISOString(),
    guest_name: 'Alexandria Montgomery', service_name: 'Highlights & Foils', stylist_name: 'Micah Shadle',
  };
  for (const kind of ['confirmation', 'reminder', 'reschedule', 'cancellation']) {
    const text = appointmentText(kind, appt, tenant);
    assert.equal(segments(text), 1, `${kind}: ${text}`);
    assert.match(text, /^Hey! This is Karen from Synergy Salon\. /);
    assert.match(text, /Reply STOP to opt out\.$/);
    assert.match(text, /Highlights & Foils/, 'the service is never cut');
  }
  // A visit too long for one: two segments, with every service kept.
  const long = { ...appt, service_name: 'Haircut + Highlights & Foils + Deep Conditioning Treatment + Blowout Styling' };
  const text = appointmentText('confirmation', long, tenant);
  assert.equal(segments(text), 2);
  assert.match(text, /Deep Conditioning Treatment \+ Blowout Styling/);
});
