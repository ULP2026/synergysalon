/**
 * Staff sessions.
 *
 * A random token in an HttpOnly cookie; only its SHA-256 is stored, so a
 * leaked database backup cannot be replayed as a login. There is no JWT here
 * on purpose: a session that cannot be revoked is the wrong shape for a shared
 * salon computer where someone leaves and access has to stop that afternoon.
 */
import { createHash, randomBytes } from 'node:crypto';

import { query } from './db.js';
import { HttpError } from './http.js';

const COOKIE = 'synergy_staff';
const SESSION_DAYS = 14;
/** Re-issued no more often than this, to avoid a write on every request. */
const TOUCH_AFTER_MIN = 30;

function hash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function createSession(res, user, userAgent = '') {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);

  await query(
    `INSERT INTO staff_sessions (user_id, token_hash, expires_at, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [user.id, hash(token), expires, String(userAgent).slice(0, 300)],
  );

  // Lax rather than Strict: the team follows links to the diary from email
  // and chat, and Strict would drop the session on the way in. Still blocks
  // the cross-site POSTs that matter.
  const parts = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 86_400}`,
  ];
  if (process.env.NODE_ENV !== 'development') parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
  return token;
}

export async function destroySession(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) await query('DELETE FROM staff_sessions WHERE token_hash = $1', [hash(token)]);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * The signed-in user, or null. Expired sessions are treated as absent and
 * cleaned up as they are encountered, which keeps the table tidy without a
 * separate job.
 */
export async function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;

  const { rows } = await query(
    `SELECT u.id, u.tenant_id, u.email, u.name, u.role, u.active, u.status, u.avatar,
            s.id AS session_id, s.last_seen_at, t.slug AS tenant_slug, t.timezone
       FROM staff_sessions s
       JOIN staff_users u ON u.id = s.user_id
       JOIN tenants t ON t.id = u.tenant_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hash(token)],
  );

  const user = rows[0];
  // A pending account has been created but not approved, and a disabled one
  // has had access taken away. Neither should survive on a cookie issued
  // earlier: revoking access has to take effect the same afternoon.
  if (!user || !user.active || user.status !== 'active') return null;

  const stale = !user.last_seen_at
    || Date.now() - new Date(user.last_seen_at).getTime() > TOUCH_AFTER_MIN * 60_000;
  if (stale) {
    await query(
      `UPDATE staff_sessions SET last_seen_at = now() WHERE id = $1;
       UPDATE staff_users SET last_seen_at = now() WHERE id = $2`,
      [user.session_id, user.id],
    ).catch(() => { /* a missed timestamp is not worth failing a request over */ });
  }
  return user;
}

/** Use at the top of every staff endpoint. */
export async function requireStaff(req, roles = null) {
  const user = await currentUser(req);
  if (!user) throw new HttpError(401, 'Please sign in.');
  if (roles && !roles.includes(user.role)) {
    throw new HttpError(403, 'You do not have access to that.');
  }
  return user;
}

/**
 * Cookies are sent on cross-site POSTs from forms, so a same-origin check is
 * what stops another site from booking or cancelling on a signed-in member of
 * staff's behalf.
 */
export function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;                       // same-origin fetch, or a server-side call
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  try {
    if (new URL(origin).host !== host) throw new Error('mismatch');
  } catch {
    throw new HttpError(403, 'Request blocked.');
  }
}
