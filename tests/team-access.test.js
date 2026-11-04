/**
 * Who may open other team members' accounts, and what a new member is sent.
 *
 * Both are rules the salon set, and both fail quietly when broken: a manager
 * who can still open a colleague's account sees nothing wrong, and a welcome
 * that lost its steps still arrives.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canManageTeam } from '../api/_lib/auth.js';
import { previewInvite, welcomeEmail } from '../api/_lib/email.js';
import { inviteText } from '../api/_lib/sms-notify.js';

test('only the owner, an admin and the support login manage the team', () => {
  assert.equal(canManageTeam({ role: 'owner', email: 'dina@example.com' }), true);
  assert.equal(canManageTeam({ role: 'admin', email: 'luis@example.com' }), true);
  assert.equal(canManageTeam({ role: 'front_desk', email: 'support@unclelouieproductions.com' }), true);
  assert.equal(canManageTeam({ role: 'stylist', email: ' Support@UncleLouieProductions.com ' }), true);
  assert.equal(canManageTeam({ role: 'manager', email: 'manager@example.com' }), false);
  assert.equal(canManageTeam({ role: 'stylist', email: 'kim@example.com' }), false);
  assert.equal(canManageTeam({ role: 'front_desk', email: 'support@unclelouieproductions.com.evil.com' }), false);
  assert.equal(canManageTeam(null), false);
});

test('the welcome email is from Karen, with the link, the app and the setup steps', () => {
  const link = 'https://app.synergysalon.com/staff/invite?t=abc';
  const e = welcomeEmail({ name: 'ZZ Test', email: 'zz@example.com', link, appUrl: 'https://app.synergysalon.com', expiresDays: 7, invitedBy: 'Dina Lara' },
    { name: 'Synergy Salon' });
  assert.match(e.subject, /welcome to Synergy Salon/);
  // From noreply@, not bookings@: it is not a booking.
  assert.equal(e.from, 'Synergy Salon <noreply@synergysalon.com>');
  // Karen introduces herself and the app, and who invited them (2026-11-04).
  for (const part of [link, 'https://app.synergysalon.com', 'zz@example.com', "I'm Karen", 'Dina has invited you',
    'Choose your password', 'Complete your profile', 'Connect your Google Calendar', '7 days']) {
    assert.ok(e.text.replace(/\u2019/g, "'").includes(part), `text is missing ${part}`);
  }
  assert.ok(e.html.includes('<ol'), 'the steps are a numbered list in the HTML');
  // There is no password to send: they choose it through the link.
  assert.ok(!/^(your )?(temporary )?password\s*:/im.test(e.text), 'no password is ever written into the email');
  assert.ok(!e.text.includes(String.fromCharCode(0x2014)), 'no long dashes');
});

test('a welcome rebuilt for Email History never carries a working link', () => {
  const e = previewInvite({ name: 'ZZ Test', email: 'zz@example.com', appUrl: 'https://app.synergysalon.com', expiresDays: 7 },
    { name: 'Synergy Salon' });
  assert.ok(!e.html.includes('invite?t='), 'no setup link in the rebuilt welcome');
  assert.ok(e.html.includes('https://app.synergysalon.com'));
});

test('the welcome text is Karen, with the link, in plain characters', () => {
  const t = inviteText({ salon: 'Synergy Salon', name: 'ZZ Nina Lee', link: 'https://app.example/invite?t=abc', expiresDays: 7 });
  assert.match(t, /^Hi ZZ! I'm Karen, the assistant at Synergy Salon\./);
  assert.ok(t.includes('https://app.example/invite?t=abc'));
  // GSM-7 only: one curly character would send it at 70 a segment.
  assert.ok(/^[\x20-\x7e]+$/.test(t), 'plain characters only');
});

test('managers are not admins: only the owner and the support login are', () => {
  // One admin rule for team management, Home and the services-free window.
  assert.equal(canManageTeam({ role: 'manager', email: 'a@b.co' }), false);
  assert.equal(canManageTeam({ role: 'owner', email: 'a@b.co' }), true);
  assert.equal(canManageTeam({ role: 'stylist', email: 'Support@UncleLouieProductions.com ' }), true);
});
