/**
 * The previews on Marketing, Automation are the messages themselves.
 *
 * They are rendered by the same functions that send, so the only way they
 * can drift is if a kind is added to one list and not the other, or the
 * preview stops carrying the shop it is for. These pin both.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { MESSAGE_KINDS, previewMessage } from '../api/_lib/email.js';

const appt = {
  guest_name: 'ZZ Sample Guest',
  guest_email: 'zz@example.com',
  service_name: 'Cut',
  stylist_name: 'ZZ Stylist',
  price_cents: null,
  starts_at: new Date('2026-10-05T14:00:00Z'),
  ref: 'SAMPLE',
  manage_token: 'preview',
};
const tenant = { name: 'ZZ Test Shop', timezone: 'America/New_York', address: '1 Main St', phone: '555 0100', email: 'hi@example.com' };

/**
 * Every kind, in two groups, because they reach a guest by different roads.
 *
 * The first four send the moment something happens. The rest go into
 * scheduled_messages and are sent later by the follow-ups cron, so a kind
 * added to MESSAGES without a card in Marketing, or queued by a trigger but
 * never written as a template, is caught here rather than by a guest
 * receiving nothing.
 */
const IMMEDIATE = ['cancellation', 'confirmation', 'reminder', 'reschedule'];
const QUEUED = [
  'aftercare', 'late_cancel', 'no_show_1', 'no_show_2', 'post_visit',
  'rebook_due', 'review_ask', 'second_visit', 'welcome_new', 'win_back',
];

test('every guest message can be previewed', () => {
  assert.deepEqual([...MESSAGE_KINDS].sort(), [...IMMEDIATE, ...QUEUED].sort());
  for (const kind of MESSAGE_KINDS) {
    const m = previewMessage(kind, appt, tenant, new Date('2026-10-04T14:00:00Z'));
    assert.ok(m.subject, `${kind} has a subject`);
    assert.match(m.from, /^ZZ Test Shop </, `${kind} is from the shop`);
    assert.equal(m.replyTo, 'hi@example.com');
    assert.match(m.html, /ZZ Test Shop/);
    assert.match(m.text, /1 Main St/);
    // No price was set, so none may appear: the preview never invents one.
    assert.ok(!/Price/.test(m.text), `${kind} shows no price`);
  }
});

test('an unknown message is not previewed', () => {
  assert.equal(previewMessage('nope', appt, tenant), null);
});

test('every email is from noreply@synergysalon.com, guests\' as well as the team\'s', () => {
  const appt = {
    starts_at: '2026-11-03T15:00:00Z', duration_min: 60, guest_name: 'ZZ Guest', guest_email: 'zz@example.com',
    service: 'Haircut', stylist: 'Dina Lara', ref: 'ZZ1', manage_token: 'x',
  };
  for (const kind of MESSAGE_KINDS) {
    const m = previewMessage(kind, appt, { name: 'Synergy Salon' }, appt.starts_at);
    assert.equal(m.from, 'Synergy Salon <noreply@synergysalon.com>', kind);
  }
});
