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
import { welcomeEmail } from '../api/_lib/email.js';

test('only the owner and the support login manage the team', () => {
  assert.equal(canManageTeam({ role: 'owner', email: 'dina@example.com' }), true);
  assert.equal(canManageTeam({ role: 'front_desk', email: 'support@unclelouieproductions.com' }), true);
  assert.equal(canManageTeam({ role: 'stylist', email: ' Support@UncleLouieProductions.com ' }), true);
  assert.equal(canManageTeam({ role: 'manager', email: 'manager@example.com' }), false);
  assert.equal(canManageTeam({ role: 'stylist', email: 'kim@example.com' }), false);
  assert.equal(canManageTeam({ role: 'front_desk', email: 'support@unclelouieproductions.com.evil.com' }), false);
  assert.equal(canManageTeam(null), false);
});

test('the welcome email carries the link, the app and the setup steps', () => {
  const link = 'https://app.synergysalon.com/staff/invite?t=abc';
  const e = welcomeEmail({ name: 'ZZ Test', email: 'zz@example.com', link, appUrl: 'https://app.synergysalon.com', expiresDays: 7 },
    { name: 'Synergy Salon' });
  assert.match(e.subject, /Welcome to the Synergy Salon team/);
  for (const part of [link, 'https://app.synergysalon.com', 'zz@example.com',
    'Complete your Team Settings', 'Connect your calendar', 'Secret address in iCal format', '7 days']) {
    assert.ok(e.text.includes(part), `text is missing ${part}`);
  }
  assert.ok(e.html.includes('<ol'), 'the steps are a numbered list in the HTML');
  // There is no password to send: they choose it through the link.
  assert.ok(!/^(your )?(temporary )?password\s*:/im.test(e.text), 'no password is ever written into the email');
});
