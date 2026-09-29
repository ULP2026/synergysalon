/**
 * GET   /api/staff/profile — the signed-in user's own details.
 * PATCH /api/staff/profile — change them, including the password.
 *
 * Everything here is scoped to whoever is holding the session. There is no id
 * in the request: a route that took one would be a route where a front-desk
 * account could edit the owner's password by guessing a uuid. Changing
 * somebody *else* is team management, and lives in team.js behind a role
 * check.
 */
import { assertSameOrigin, requireStaff } from '../../_lib/auth.js';
import { query } from '../../_lib/db.js';
import {
  HttpError, handler, json, readJson, requireEmail, requireString,
} from '../../_lib/http.js';
import { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from '../../_lib/password.js';

/**
 * An avatar, or nothing.
 *
 * The browser resizes to 256px and re-encodes before sending, so anything
 * much larger than this either failed to resize or was not sent by our own
 * page. Either way it does not belong in a row.
 */
const MAX_AVATAR = 300 * 1024;

function avatarFrom(value) {
  if (value === null) return null;                 // an explicit "remove it"
  const s = String(value || '').trim();
  if (!s) return undefined;                        // absent: leave it alone
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) {
    throw new HttpError(400, 'That does not look like an image.');
  }
  if (s.length > MAX_AVATAR) {
    throw new HttpError(413, 'That picture is too large. Please choose a smaller one.');
  }
  return s;
}

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req);
    const { rows } = await query(
      `SELECT name, email, phone, role, avatar, created_at, last_seen_at
         FROM staff_users WHERE id = $1`,
      [user.id],
    );
    const me = rows[0];
    if (!me) throw new HttpError(404, 'That account no longer exists.');
    return json(res, 200, {
      name: me.name,
      email: me.email,
      phone: me.phone,
      role: me.role,
      avatar: me.avatar,
      since: me.created_at,
      lastSeen: me.last_seen_at,
      minPasswordLength: MIN_PASSWORD_LENGTH,
    });
  },

  async PATCH(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req);
    const body = await readJson(req);

    const sets = [];
    const params = [user.id];
    const add = (sql, value) => { params.push(value); sets.push(`${sql} = $${params.length}`); };

    if (body.name !== undefined) add('name', requireString(body.name, 'Name', { max: 120 }));
    if (body.phone !== undefined) {
      add('phone', String(body.phone || '').trim().slice(0, 40));
    }

    if (body.email !== undefined) {
      const email = requireEmail(body.email);
      // The unique index is on (tenant_id, lower(email)), so this is a
      // friendlier version of the error the database would raise anyway.
      const { rows: clash } = await query(
        `SELECT 1 FROM staff_users
          WHERE tenant_id = $1 AND lower(email) = $2 AND id <> $3`,
        [user.tenant_id, email, user.id],
      );
      if (clash[0]) throw new HttpError(409, 'Somebody here already signs in with that email.');
      add('email', email);
    }

    const avatar = avatarFrom(body.avatar);
    if (avatar !== undefined) add('avatar', avatar);

    if (body.newPassword !== undefined) {
      // Knowing the current password is what stops a borrowed unlocked laptop
      // from becoming a permanent account takeover.
      const current = requireString(body.currentPassword, 'Current password', { max: 200 });
      const { rows } = await query('SELECT password_hash FROM staff_users WHERE id = $1', [user.id]);
      if (!await verifyPassword(current, rows[0]?.password_hash)) {
        throw new HttpError(403, 'That is not your current password.');
      }
      const next = requireString(body.newPassword, 'New password', { max: 200 });
      if (next.length < MIN_PASSWORD_LENGTH) {
        throw new HttpError(400, `Your new password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
      }
      add('password_hash', await hashPassword(next));
    }

    if (!sets.length) throw new HttpError(400, 'Nothing to change.');

    const { rows } = await query(
      `UPDATE staff_users SET ${sets.join(', ')} WHERE id = $1
        RETURNING name, email, phone, role, avatar`,
      params,
    );
    return json(res, 200, { ...rows[0], saved: true });
  },
});
