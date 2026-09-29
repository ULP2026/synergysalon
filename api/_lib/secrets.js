/**
 * Encrypting the things a database copy should not hand over.
 *
 * A Google refresh token does not expire and is enough on its own to read and
 * write somebody's calendar until they revoke it. Stored as it arrives, a
 * dump of this database is a dump of the team's Google accounts. Stored like
 * this, it is useless without a key that lives in the environment instead.
 *
 * AES-256-GCM, so tampering is detected rather than silently decrypted into
 * something else. Each value gets its own random nonce, which is why the same
 * token encrypted twice does not produce the same string.
 */
import {
  createCipheriv, createDecipheriv, createHash, randomBytes,
} from 'node:crypto';

const PREFIX = 'v1';

/**
 * The key, derived from TOKEN_KEY so any passphrase length works.
 *
 * Deliberately thrown rather than defaulted. A default key is the same as no
 * encryption, except that it looks like encryption in a code review.
 */
function key() {
  const raw = process.env.TOKEN_KEY;
  if (!raw || raw.length < 16) {
    throw new Error('TOKEN_KEY is missing or too short; refusing to store a token in the clear.');
  }
  return createHash('sha256').update(raw).digest();
}

export function encryptSecret(plain) {
  if (plain == null || plain === '') return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [PREFIX, iv.toString('base64url'), c.getAuthTag().toString('base64url'),
    body.toString('base64url')].join('.');
}

export function decryptSecret(stored) {
  if (!stored) return null;
  const [version, iv, tag, body] = String(stored).split('.');
  if (version !== PREFIX || !iv || !tag || !body) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  } catch {
    // A wrong key or a tampered value. Returning null makes the caller treat
    // the connection as broken, which is what it is.
    return null;
  }
}

/** Whether this deployment can store tokens at all. */
export function canStoreSecrets() {
  try { key(); return true; } catch { return false; }
}
