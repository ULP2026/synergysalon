/**
 * Password hashing with scrypt from Node's standard library.
 *
 * scrypt rather than bcrypt or argon2 because both of those are native
 * modules that have to compile, and a serverless deploy that fails to build
 * its password library at 6pm on a Friday is a bad trade for a marginally
 * better algorithm. scrypt is memory-hard, built in, and entirely adequate
 * for a salon's staff logins.
 *
 * Format: scrypt$N$r$p$<salt base64>$<hash base64>
 * The parameters travel with the hash, so they can be raised later without
 * invalidating everyone's existing password.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// ~100ms on a warm function. High enough to make guessing expensive, low
// enough that signing in does not feel broken.
const N = 16384;
const r = 8;
const p = 1;
const KEY_LEN = 64;

export const MIN_PASSWORD_LENGTH = 10;

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LEN, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/**
 * Always does the work, even when the stored hash is malformed or the user
 * does not exist, so a failed sign-in takes the same time either way and
 * cannot be used to discover which email addresses are real.
 */
export async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  const [scheme, n, rr, pp, saltB64, hashB64] = parts;
  const wellFormed = parts.length === 6 && scheme === 'scrypt';

  // Parameters are only taken from the stored hash when they are plausible.
  // A truncated or corrupted row would otherwise hand scrypt values it
  // rejects outright, turning a failed sign-in into a 500 -- and telling an
  // attacker exactly which accounts have a broken hash.
  const parsed = { N: Number(n), r: Number(rr), p: Number(pp) };
  const usable = wellFormed
    && Number.isInteger(parsed.N) && parsed.N > 1 && (parsed.N & (parsed.N - 1)) === 0
    && Number.isInteger(parsed.r) && parsed.r > 0
    && Number.isInteger(parsed.p) && parsed.p > 0;

  const params = usable ? parsed : { N, r, p };
  const salt = wellFormed && saltB64 ? Buffer.from(saltB64, 'base64') : randomBytes(16);
  const decoded = wellFormed && hashB64 ? Buffer.from(hashB64, 'base64') : null;
  // Still hash something of the usual size, so the work is done either way.
  const expected = decoded?.length ? decoded : randomBytes(KEY_LEN);

  const key = await scryptAsync(String(password ?? ''), salt, expected.length, {
    ...params,
    maxmem: 64 * 1024 * 1024,
  });

  if (!wellFormed) return false;
  return key.length === expected.length && timingSafeEqual(key, expected);
}
