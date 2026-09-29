/**
 * Encrypting a Google refresh token.
 *
 * That token does not expire and is enough on its own to read and write
 * somebody's calendar until they revoke it. These are the properties that
 * make storing it acceptable: it cannot be read without the key, a tampered
 * value is refused rather than quietly returning something else, and the same
 * token never encrypts to the same string twice.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TOKEN_KEY = process.env.TOKEN_KEY || 'a-test-key-long-enough-to-pass';
const { canStoreSecrets, decryptSecret, encryptSecret } = await import('../api/_lib/secrets.js');

test('a token survives the round trip', () => {
  const token = '1//0gH_fake-refresh-token_xyz';
  assert.equal(decryptSecret(encryptSecret(token)), token);
});

test('the stored form does not contain the token', () => {
  const token = 'super-secret-refresh-token';
  assert.ok(!encryptSecret(token).includes(token));
});

test('the same token encrypts differently every time', () => {
  // Otherwise two people with the same token are visibly the same in a dump.
  assert.notEqual(encryptSecret('same'), encryptSecret('same'));
});

test('a tampered value is refused, not decrypted into something else', () => {
  const stored = encryptSecret('original');
  const parts = stored.split('.');
  parts[3] = Buffer.from('tampered-body').toString('base64url');
  assert.equal(decryptSecret(parts.join('.')), null);
});

test('the wrong key returns nothing rather than rubbish', async () => {
  const stored = encryptSecret('original');
  process.env.TOKEN_KEY = 'a-completely-different-key-here';
  assert.equal(decryptSecret(stored), null);
  process.env.TOKEN_KEY = 'a-test-key-long-enough-to-pass';
});

test('nothing in, nothing out', () => {
  assert.equal(encryptSecret(''), null);
  assert.equal(encryptSecret(null), null);
  assert.equal(decryptSecret(null), null);
  assert.equal(decryptSecret('not-even-close'), null);
});

test('a short or missing key is refused outright', () => {
  const real = process.env.TOKEN_KEY;
  // A default key is the same as no encryption, except that it looks like
  // encryption in a code review.
  process.env.TOKEN_KEY = '';
  assert.equal(canStoreSecrets(), false);
  assert.throws(() => encryptSecret('x'), /TOKEN_KEY/);
  process.env.TOKEN_KEY = 'short';
  assert.equal(canStoreSecrets(), false);
  process.env.TOKEN_KEY = real;
  assert.equal(canStoreSecrets(), true);
});
