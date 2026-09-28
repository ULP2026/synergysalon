/** Staff password hashing. No database needed. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from '../api/_lib/password.js';

test('a password verifies against its own hash', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('correct horse batter', hash), false);
  assert.equal(await verifyPassword('', hash), false);
});

test('the same password hashes differently every time', async () => {
  const a = await hashPassword('correct horse battery');
  const b = await hashPassword('correct horse battery');
  assert.notEqual(a, b, 'a per-password salt means no two hashes match');
  assert.equal(await verifyPassword('correct horse battery', b), true);
});

test('short passwords are refused', async () => {
  await assert.rejects(() => hashPassword('short'), /at least/);
  assert.ok(MIN_PASSWORD_LENGTH >= 8);
});

test('a malformed or missing hash never verifies', async () => {
  // These are the shapes a bug or a half-finished migration would produce.
  for (const stored of [undefined, null, '', 'not-a-hash', 'scrypt$1$2$3', '$$$$$']) {
    assert.equal(await verifyPassword('anything at all', stored), false, String(stored));
  }
});

test('verifying an unknown user still does the work', async () => {
  // Sign-in must take about as long whether or not the account exists, or the
  // response time tells an attacker which email addresses are real.
  const hash = await hashPassword('correct horse battery');

  const t0 = performance.now();
  await verifyPassword('wrong guess entirely', hash);
  const real = performance.now() - t0;

  const t1 = performance.now();
  await verifyPassword('wrong guess entirely', undefined);
  const missing = performance.now() - t1;

  // Generous bound: this is checking that the missing case does the scrypt
  // work at all, not that the two are identical on a noisy machine.
  assert.ok(missing > real / 4, `missing-user path took ${missing.toFixed(0)}ms vs ${real.toFixed(0)}ms`);
});
