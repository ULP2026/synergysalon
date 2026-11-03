/**
 * A new team member is texted their setup link (asked for 2026-11-03), from
 * Karen's number, so they can finish setting up on their phone. Never
 * throws: an invite that could not be texted still has its email.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { textInvite } from '../api/_lib/sms-notify.js';

const tenant = { id: 1, name: 'Synergy Salon', karen_phone: '+18135550199' };
const db = { query: async () => ({ rows: [{ name: 'Synergy Salon', karen_phone: '+18135550199' }] }) };

test('texts the setup link to a new team member', async () => {
  const sent = [];
  const send = async (msg) => { sent.push(msg); return { sid: 'SMx' }; };
  const r = await textInvite({ tenant, phone: '(813) 555-0144', name: 'ZZ Nina Lee', link: 'https://app.example/invite?t=abc', expiresDays: 7 }, { send, db });
  assert.equal(r.texted, true);
  assert.equal(sent.length, 1);
  assert.match(String(sent[0].to), /8135550144/);
  assert.match(sent[0].body, /Hi ZZ!/);
  assert.match(sent[0].body, /https:\/\/app\.example\/invite\?t=abc/);
  assert.ok(!sent[0].body.includes(String.fromCharCode(0x2014)), 'no long dashes');
});

test('skips without a phone, and never throws when sending fails', async () => {
  const none = await textInvite({ tenant, phone: '', name: 'ZZ', link: 'x' }, { send: async () => { throw new Error('no'); }, db });
  assert.equal(none.texted, undefined);
  const failed = await textInvite({ tenant, phone: '8135550144', name: 'ZZ', link: 'x' }, { send: async () => { throw new Error('down'); }, db });
  assert.notEqual(failed.texted, true);
});
