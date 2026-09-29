/**
 * What counts as knowing who somebody is.
 *
 * /api/enquiry is called as the booking wizard is filled in, so it sees every
 * prefix of an email address on the way past. Treating those as addresses cost
 * a day twice: one guest booking once became five contacts and four
 * appointments, and every one of them was rejected by CENTRO with "email must
 * be an email" — permanently, which took the appointments down with them.
 *
 * These are the rules that stop it. They are cheap to run and the bug they
 * guard against is silent, which is the combination worth a test.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionIdFrom, settledEmail, settledPhone } from '../api/enquiry.js';

test('a half-typed address is not an address', () => {
  // Every one of these was stored as a real contact by the version that
  // shipped, in a single sitting, by one person typing one address.
  for (const prefix of ['s', 'suoo', 'support', 'support.unclelouiepro',
    'support@', 'support@unclelouieproductions', 'support@unclelouie.']) {
    assert.equal(settledEmail(prefix), '', `${prefix} should not count yet`);
  }
});

test('a whole address counts, whatever case it was typed in', () => {
  assert.equal(settledEmail('  Support@UncleLouieProductions.com '),
               'support@unclelouieproductions.com');
  assert.equal(settledEmail('a.b+tag@sub.example.co.uk'), 'a.b+tag@sub.example.co.uk');
});

test('a number being typed is unfinished, not short', () => {
  for (const partial of ['', '8', '813', '813-55']) {
    assert.equal(settledPhone(partial), '', `${partial} should not count yet`);
  }
  assert.equal(settledPhone('813-555-0142'), '813-555-0142');
  assert.equal(settledPhone('+639066507091'), '+639066507091');
});

test('the session id survives what the guest is typing', () => {
  // The point of it: unlike the email box, it is the same on every call the
  // wizard makes, so all of them resolve to one contact.
  const id = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6';
  assert.equal(sessionIdFrom(id), id);
  assert.equal(sessionIdFrom('bk-m1x2y3-ab12cd34ef'), 'bk-m1x2y3-ab12cd34ef');
});

test('a session id that could be anything is treated as none', () => {
  // It picks a contact out of the table, so it is never taken on trust.
  for (const bad of ['', 'short', "' OR 1=1 --", 'has space', '<script>', null, 42]) {
    assert.equal(sessionIdFrom(bad), '', `${String(bad)} should be rejected`);
  }
});
