/**
 * Forgot Password? (asked for 2026-11-06).
 *
 * POST /api/staff/reset {action: 'request', email} : emails a reset link to
 *      that address if it signs in here. The answer is the same whether it
 *      does or not, and arrives as fast either way (the lookup and the email
 *      happen after the answer is sent), so the form cannot be used to find
 *      out who has an account.
 * GET  /api/staff/reset?t=<token>                    : whether the link still
 *      works, and for which address.
 * POST /api/staff/reset {action: 'reset', t, password} : sets the new
 *      password, spends the link, and signs out every session that used the
 *      old one. They then sign in with the new password.
 *
 * Public on purpose: whoever is here cannot sign in, which is the point. The
 * token is the authorisation and is treated like one, as an invite's is
 * (invite.js): random, only its SHA-256 kept, good for an hour, spent on use,
 * and replaced by any newer request. Requests for one account are at least
 * two minutes apart, so the form cannot flood an inbox.
 */
import { createHash, randomBytes } from 'node:crypto';

import { waitUntil } from '@vercel/functions';

import { assertSameOrigin } from '../../_lib/auth.js';
import { query } from '../../_lib/db.js';
import { sendPasswordReset } from '../../_lib/email.js';
import { HttpError, handler, json, readJson, requireString } from '../../_lib/http.js';
import { MIN_PASSWORD_LENGTH, hashPassword } from '../../_lib/password.js';
import { tenantForRequest } from '../../_lib/tenant.js';

export const RESET_MINUTES = 60;
const SPACING_MINUTES = 2;
const hash = (token) => createHash('sha256').update(token).digest('hex');

/** Said for every request, whether or not the address has an account. */
export const SENT = 'If that email has an account here, a link to choose a new password is on its way. '
  + `It works once, for ${RESET_MINUTES} minutes. Check your spam folder if it has not arrived in a few minutes.`;

/** The same answer for every kind of bad link. */
const DEAD = () => new HttpError(410,
  'This reset link has expired, has already been used, or was replaced by a newer one. '
  + 'Ask for a new one from the sign-in page.', 'RESET_DEAD');

/** The app's own address on this host: app.synergysalon.com has no /staff in its addresses (vercel.json). */
function appBase(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  return `${proto}://${host}${host.startsWith('app.') ? '' : '/staff'}`;
}

/**
 * Send the link, if the address signs in here. Run after the answer has
 * gone, so its time is never part of the answer. A login waiting for the
 * owner's approval, or switched off, gets nothing: it could not sign in
 * with a new password either.
 */
export async function requestReset(req, tenant, email) {
  const { rows } = await query(
    `SELECT id, name, email FROM staff_users
      WHERE tenant_id = $1 AND lower(email) = $2 AND active AND status = 'active'
        AND (reset_requested_at IS NULL OR reset_requested_at < now() - make_interval(mins => $3::int))`,
    [tenant.id, email, SPACING_MINUTES],
  );
  const user = rows[0];
  if (!user) return { sent: false };
  const token = randomBytes(32).toString('base64url');
  await query(
    `UPDATE staff_users
        SET reset_hash = $2, reset_expires_at = now() + make_interval(mins => $3::int), reset_requested_at = now()
      WHERE id = $1`,
    [user.id, hash(token), RESET_MINUTES],
  );
  const link = `${appBase(req)}/reset?t=${token}`;
  await sendPasswordReset({ name: user.name, email: user.email, link, minutes: RESET_MINUTES }, tenant);
  return { sent: true, link };
}

async function resetFor(token) {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(String(token || ''))) throw DEAD();
  const { rows } = await query(
    `SELECT u.id, u.email FROM staff_users u JOIN tenants t ON t.id = u.tenant_id
      WHERE u.reset_hash = $1 AND u.reset_expires_at > now() AND u.active AND u.status = 'active' AND t.active`,
    [hash(token)],
  );
  if (!rows[0]) throw DEAD();
  return rows[0];
}

export default handler({
  async GET(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const row = await resetFor(url.searchParams.get('t'));
    return json(res, 200, { email: row.email, minPasswordLength: MIN_PASSWORD_LENGTH });
  },

  async POST(req, res) {
    assertSameOrigin(req);
    const body = await readJson(req);
    const action = String(body.action || '');

    if (action === 'request') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        throw new HttpError(400, 'Type the email you sign in with.');
      }
      const tenant = await tenantForRequest(req);
      // After the answer: its time tells nobody whether the address exists.
      waitUntil(requestReset(req, tenant, email)
        .catch((err) => console.error('password reset email failed', err.message)));
      return json(res, 200, { ok: true, message: SENT });
    }

    if (action === 'reset') {
      const password = requireString(body.password, 'Password', { max: 200 });
      if (password.length < MIN_PASSWORD_LENGTH) throw new HttpError(400, `Choose at least ${MIN_PASSWORD_LENGTH} characters.`);
      const row = await resetFor(body.t);
      // Spent in the same statement that sets the password, so a link cannot
      // be used twice even if it is pressed twice. A lock from wrong guesses
      // goes too: they have just proved they own the address.
      const { rows } = await query(
        `UPDATE staff_users
            SET password_hash = $2, reset_hash = NULL, reset_expires_at = NULL,
                failed_attempts = 0, locked_until = NULL
          WHERE id = $1 AND reset_hash = $3 AND reset_expires_at > now()
          RETURNING id, email`,
        [row.id, await hashPassword(password), hash(body.t)],
      );
      if (!rows[0]) throw DEAD();
      // Whoever had the old password is signed out everywhere.
      await query('DELETE FROM staff_sessions WHERE user_id = $1', [row.id]);
      return json(res, 200, { ok: true, email: rows[0].email });
    }

    throw new HttpError(400, 'Unknown request.');
  },
});
