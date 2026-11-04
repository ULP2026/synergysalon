/**
 * GET  /api/staff/invite?t=<token>  : who this invite is for, or, for the
 *                                    same link after the password was chosen
 *                                    and before setup is finished, `resume`
 *                                    and the step they are on (047).
 * POST /api/staff/invite            — { t, password } sets it and signs them in.
 *
 * Public on purpose: somebody accepting an invite has no session yet, which is
 * the whole point. The token is the authorisation, so it is treated like one —
 * only its hash is stored, it expires, and it is spent the moment it is used.
 *
 * A wrong or stale token says the same thing as a well-formed one that is not
 * ours. Telling the difference would let somebody discover whether a given
 * invite exists.
 */
import { createHash } from 'node:crypto';

import { createSession } from '../../_lib/auth.js';
import { query } from '../../_lib/db.js';
import {
  HttpError, handler, json, readJson, requireString,
} from '../../_lib/http.js';
import { MIN_PASSWORD_LENGTH, hashPassword } from '../../_lib/password.js';

const hash = (token) => createHash('sha256').update(token).digest('hex');

/** The same answer for every kind of bad token. */
// It says both ways forward (2026-11-04): somebody who already chose a
// password only needs to sign in, and a resend ends any earlier link.
const DEAD = () => new HttpError(410,
  'This invite link has expired, has already been used, or was replaced by a newer one. '
  + 'If you already chose your password, sign in to finish setting up. Otherwise use the newest link Karen sent you, '
  + 'or ask the salon to send another.', 'INVITE_DEAD');

async function inviteFor(token) {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(String(token || ''))) throw DEAD();
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.role, u.invite_expires_at,
            t.name AS salon
       FROM staff_users u
       JOIN tenants t ON t.id = u.tenant_id
      WHERE u.invite_hash = $1 AND u.active AND t.active`,
    [hash(token)],
  );
  const row = rows[0];
  if (!row) throw DEAD();
  if (!row.invite_expires_at || new Date(row.invite_expires_at) < new Date()) throw DEAD();
  return row;
}

/**
 * The same link after its password was chosen (047): who it was for and the
 * step they are on, while they are still setting up. Grants nothing: no
 * session, no password. Null when it is not such a link.
 */
async function resumeFor(token) {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(String(token || ''))) return null;
  try {
    const { rows } = await query(
      `SELECT u.name, u.email, t.name AS salon, to_jsonb(u) ->> 'onboarding_step' AS step
         FROM staff_users u JOIN tenants t ON t.id = u.tenant_id
        WHERE u.setup_hash = $1 AND u.active AND t.active
          AND (to_jsonb(u) ->> 'onboarded_at') IS NULL`,
      [hash(token)],
    );
    return rows[0] || null;
  } catch (err) {
    if (err.code === '42703') return null;   // before 047
    throw err;
  }
}

export default handler({
  async GET(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('t');
    // Clicked again after choosing a password, before finishing setup
    // (2026-11-04): back to where they were, not "expired".
    const back = await resumeFor(token);
    if (back) {
      return json(res, 200, { resume: true, name: back.name, email: back.email, salon: back.salon, step: back.step || null });
    }
    const row = await inviteFor(token);
    return json(res, 200, {
      name: row.name,
      email: row.email,
      salon: row.salon,
      minPasswordLength: MIN_PASSWORD_LENGTH,
    });
  },

  async POST(req, res) {
    const body = await readJson(req);
    if (await resumeFor(body.t)) {
      throw new HttpError(409, 'You already chose your password. Sign in to carry on setting up.', 'INVITE_RESUME');
    }
    const row = await inviteFor(body.t);

    const password = requireString(body.password, 'Password', { max: 200 });
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new HttpError(400, `Choose at least ${MIN_PASSWORD_LENGTH} characters.`);
    }

    // Spent in the same statement that sets the password, so a link cannot be
    // used twice even if it is clicked twice. Its hash is kept as setup_hash
    // (047) so the same link can bring them back to their setup later.
    const { rows } = await query(
      `UPDATE staff_users
          SET password_hash = $2,
              invite_hash = NULL, invite_expires_at = NULL,
              status = 'active', failed_attempts = 0, locked_until = NULL
        WHERE id = $1 AND invite_hash IS NOT NULL
        RETURNING id, tenant_id, email, name, role`,
      [row.id, await hashPassword(password)],
    );
    if (!rows[0]) throw DEAD();
    await query('UPDATE staff_users SET setup_hash = $2 WHERE id = $1', [row.id, hash(body.t)])
      .catch((err) => { if (err.code !== '42703') throw err; });

    // Straight in, rather than back to a sign-in page to type the password
    // they chose ten seconds ago.
    await createSession(res, rows[0], req.headers['user-agent'] || '');
    return json(res, 200, { ok: true, name: rows[0].name });
  },
});
