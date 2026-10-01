/**
 * /api/staff/team: who has access, and who is asking for it.
 *
 *   GET    the team, pending requests first
 *   POST   add someone, edit their details, approve, reject, disable,
 *          re-enable, or change a role
 *
 * Owners and managers only. A front-desk account can use the console all day
 * but cannot grant anybody else access to the salon's client list.
 */
import { assertSameOrigin, requireStaff } from '../../_lib/auth.js';
import { query } from '../../_lib/db.js';
import {
  HttpError, handler, json, readJson, requireEmail, requireString,
} from '../../_lib/http.js';
import { MIN_PASSWORD_LENGTH, hashPassword } from '../../_lib/password.js';
import { tenantForUser } from '../../_lib/tenant.js';
import { assertUsernameFree, avatarFrom, usernameFrom } from './profile.js';

const ADMIN = ['owner', 'manager'];
const ROLES = ['owner', 'manager', 'front_desk'];

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req, ADMIN);
    const tenant = await tenantForUser(user);

    const { rows } = await query(
      // username and pricing through to_jsonb, so the team still lists on a
      // database that has not had migration 011 yet.
      `SELECT u.id, u.name, u.email, u.role, u.status, u.note, u.avatar,
              u.requested_at, u.approved_at, u.last_seen_at, u.created_at,
              to_jsonb(u) ->> 'username' AS username,
              to_jsonb(u) ->> 'pricing' AS pricing,
              a.name AS approved_by_name,
              s.name AS stylist_name, s.slug AS stylist_slug, s.title AS stylist_title
         FROM staff_users u
         LEFT JOIN staff_users a ON a.id = u.approved_by
         LEFT JOIN stylists s ON s.staff_user_id = u.id
        WHERE u.tenant_id = $1
        ORDER BY (u.status = 'pending') DESC, u.requested_at, u.name`,
      [tenant.id],
    );

    return json(res, 200, {
      you: { id: user.id, role: user.role },
      pending: rows.filter((r) => r.status === 'pending').length,
      members: rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        role: r.role,
        status: r.status,
        note: r.note,
        avatar: r.avatar,
        username: r.username || '',
        pricing: r.pricing || '',
        stylist: r.stylist_name,
        stylistSlug: r.stylist_slug,
        title: r.stylist_title || '',
        requestedAt: r.requested_at,
        approvedAt: r.approved_at,
        approvedBy: r.approved_by_name,
        lastSeenAt: r.last_seen_at,
      })),
    });
  },

  async POST(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req, ADMIN);
    const tenant = await tenantForUser(user);
    const body = await readJson(req);

    const action = requireString(body.action, 'Action', { max: 20 });

    // Adding somebody directly, rather than waiting for them to ask. The
    // account is active immediately, because an owner adding a person has
    // already made the decision that approval exists to capture.
    if (action === 'create') {
      const name = requireString(body.name, 'Name', { max: 120 });
      const email = requireEmail(body.email);
      const password = requireString(body.password, 'Password', { max: 200 });
      if (password.length < MIN_PASSWORD_LENGTH) {
        throw new HttpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      }
      const role = ROLES.includes(body.role) ? body.role : 'front_desk';
      if (role === 'owner' && user.role !== 'owner') {
        throw new HttpError(403, 'Only an owner can make someone else an owner.');
      }

      const { rows: exists } = await query(
        'SELECT id FROM staff_users WHERE tenant_id = $1 AND lower(email) = $2',
        [tenant.id, email],
      );
      if (exists[0]) throw new HttpError(409, 'Someone already has that email address.');

      const username = usernameFrom(body.username ?? null);
      await assertUsernameFree(tenant.id, username, null);
      const avatar = avatarFrom(body.avatar) ?? null;
      const pricing = String(body.pricing || '').trim().slice(0, 120);

      const { rows } = await query(
        `INSERT INTO staff_users (tenant_id, email, password_hash, name, role,
                                  status, approved_at, approved_by)
         VALUES ($1, $2, $3, $4, $5, 'active', now(), $6)
         RETURNING id, name, email, role`,
        [tenant.id, email, await hashPassword(password), name, role, user.id],
      );
      // The profile extras go in a second statement so adding a person still
      // works on a database that has not had migration 011; only the extras
      // need it.
      if (avatar) await query('UPDATE staff_users SET avatar = $2 WHERE id = $1', [rows[0].id, avatar]);
      if (username || pricing) {
        await query('UPDATE staff_users SET username = $2, pricing = $3 WHERE id = $1',
          [rows[0].id, username, pricing]);
      }
      return json(res, 201, { ok: true, member: rows[0] });
    }

    const id = requireString(body.id, 'Member', { max: 64 });

    const { rows } = await query(
      'SELECT id, name, role, status FROM staff_users WHERE id = $1 AND tenant_id = $2',
      [id, tenant.id],
    );
    const target = rows[0];
    if (!target) throw new HttpError(404, 'No such team member.');

    // Removing your own access, or demoting yourself, is almost always a
    // mistake and can leave a salon with no owner at all.
    if (target.id === user.id && action !== 'note') {
      throw new HttpError(400, 'You cannot change your own access.');
    }

    switch (action) {
      case 'approve': {
        const role = ROLES.includes(body.role) ? body.role : 'front_desk';
        await query(
          `UPDATE staff_users
              SET status = 'active', active = true, role = $2,
                  approved_at = now(), approved_by = $3,
                  failed_attempts = 0, locked_until = NULL
            WHERE id = $1`,
          [target.id, role, user.id],
        );
        break;
      }

      case 'reject':
        // Deleted rather than marked, so the same person can ask again later
        // without an owner having to find and undo an old rejection.
        await query("DELETE FROM staff_users WHERE id = $1 AND status = 'pending'", [target.id]);
        break;

      case 'disable':
        await query(
          "UPDATE staff_users SET status = 'disabled', active = false WHERE id = $1",
          [target.id],
        );
        // Their sessions die now, not in two weeks when the cookie expires.
        await query('DELETE FROM staff_sessions WHERE user_id = $1', [target.id]);
        break;

      case 'enable':
        await query(
          "UPDATE staff_users SET status = 'active', active = true WHERE id = $1",
          [target.id],
        );
        break;

      case 'role': {
        const role = requireString(body.role, 'Role', { max: 20 });
        if (!ROLES.includes(role)) throw new HttpError(400, 'That is not a role.');
        // Only an owner can make another owner.
        if (role === 'owner' && user.role !== 'owner') {
          throw new HttpError(403, 'Only an owner can make someone else an owner.');
        }
        await query('UPDATE staff_users SET role = $2 WHERE id = $1', [target.id, role]);
        break;
      }

      // The team modal: name, email, username, pricing and picture together.
      // Each is changed only when sent, so a field nobody touched is left as
      // it was.
      case 'update': {
        if (target.role === 'owner' && user.role !== 'owner') {
          throw new HttpError(403, 'Only an owner can change another owner.');
        }
        const sets = [];
        const params = [target.id];
        const add = (col, value) => { params.push(value); sets.push(`${col} = $${params.length}`); };
        if (body.name !== undefined) add('name', requireString(body.name, 'Name', { max: 120 }));
        if (body.email !== undefined) {
          const email = requireEmail(body.email);
          const { rows: clash } = await query(
            `SELECT 1 FROM staff_users
              WHERE tenant_id = $1 AND lower(email) = $2 AND id <> $3`,
            [tenant.id, email, target.id],
          );
          if (clash[0]) throw new HttpError(409, 'Somebody here already signs in with that email.');
          add('email', email);
        }
        if (body.username !== undefined) {
          const username = usernameFrom(body.username);
          await assertUsernameFree(tenant.id, username, target.id);
          add('username', username);
        }
        if (body.pricing !== undefined) add('pricing', String(body.pricing || '').trim().slice(0, 120));
        const avatar = avatarFrom(body.avatar);
        if (avatar !== undefined) add('avatar', avatar);
        if (body.role !== undefined) {
          if (!ROLES.includes(body.role)) throw new HttpError(400, 'That is not a role.');
          if (body.role === 'owner' && user.role !== 'owner') {
            throw new HttpError(403, 'Only an owner can make someone else an owner.');
          }
          add('role', body.role);
        }
        if (!sets.length) throw new HttpError(400, 'Nothing to change.');
        await query(`UPDATE staff_users SET ${sets.join(', ')} WHERE id = $1`, params);
        break;
      }

      default:
        throw new HttpError(400, `"${action}" is not something you can do here.`);
    }

    return json(res, 200, { ok: true, id: target.id, action });
  },
});
