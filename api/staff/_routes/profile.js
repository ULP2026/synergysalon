/**
 * GET   /api/staff/profile: the signed-in user's own details.
 * PATCH /api/staff/profile: change them, including the password.
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

export function avatarFrom(value) {
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

/**
 * A username, normalised, or null to clear it.
 *
 * Lower case and a narrow alphabet so it reads the same on every screen and
 * cannot be made to look like somebody else's with lookalike characters.
 */
export function usernameFrom(value) {
  if (value === null) return null;
  const s = String(value ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!s) return null;
  if (!/^[a-z0-9._-]{3,32}$/.test(s)) {
    throw new HttpError(400, 'A username is 3 to 32 letters, numbers, dots, dashes or underscores.');
  }
  return s;
}

/** Friendlier than the unique index's own error. */
export async function assertUsernameFree(tenantId, username, exceptId) {
  if (!username) return;
  const { rows } = await query(
    `SELECT 1 FROM staff_users
      WHERE tenant_id = $1 AND lower(username) = $2 AND id <> $3`,
    [tenantId, username, exceptId ?? '00000000-0000-0000-0000-000000000000'],
  );
  if (rows[0]) throw new HttpError(409, 'Somebody here already uses that username.');
}

/** Pricing describes how a stylist charges; owners and managers set it. */
const CAN_PRICE = ['owner', 'manager'];

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req);
    // to_jsonb reads the two newer columns without naming them, so this page
    // still loads on a database that has not had migration 011 yet.
    const { rows } = await query(
      `SELECT name, email, phone, role, avatar, created_at, last_seen_at,
              to_jsonb(u) ->> 'username' AS username,
              to_jsonb(u) ->> 'pricing' AS pricing
         FROM staff_users u WHERE id = $1`,
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
      username: me.username || '',
      pricing: me.pricing || '',
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

    if (body.username !== undefined) {
      const username = usernameFrom(body.username);
      await assertUsernameFree(user.tenant_id, username, user.id);
      add('username', username);
    }
    if (body.pricing !== undefined && CAN_PRICE.includes(user.role)) {
      add('pricing', String(body.pricing || '').trim().slice(0, 120));
    }

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
        RETURNING name, email, phone, role, avatar,
                  to_jsonb(staff_users) ->> 'username' AS username,
                  to_jsonb(staff_users) ->> 'pricing' AS pricing`,
      params,
    );
    return json(res, 200, { ...rows[0], saved: true });
  },
});
