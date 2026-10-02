/**
 * GET  /api/staff/invite?t=<token>  — who this invite is for.
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
const DEAD = () => new HttpError(410,
  'This invite link has expired or has already been used. Ask the salon to send another.');

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

export default handler({
  async GET(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const row = await inviteFor(url.searchParams.get('t'));
    return json(res, 200, {
      name: row.name,
      email: row.email,
      salon: row.salon,
      minPasswordLength: MIN_PASSWORD_LENGTH,
    });
  },

  async POST(req, res) {
    const body = await readJson(req);
    const row = await inviteFor(body.t);

    const password = requireString(body.password, 'Password', { max: 200 });
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new HttpError(400, `Choose at least ${MIN_PASSWORD_LENGTH} characters.`);
    }

    // Spent in the same statement that sets the password, so a link cannot be
    // used twice even if it is clicked twice.
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

    // Straight in, rather than back to a sign-in page to type the password
    // they chose ten seconds ago.
    await createSession(res, rows[0], req.headers['user-agent'] || '');
    return json(res, 200, { ok: true, name: rows[0].name });
  },
});
