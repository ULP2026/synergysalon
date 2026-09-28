/**
 * /api/staff/team — who has access, and who is asking for it.
 *
 *   GET    the team, pending requests first
 *   POST   approve, reject, disable, re-enable, or change a role
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

const ADMIN = ['owner', 'manager'];
const ROLES = ['owner', 'manager', 'front_desk'];

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req, ADMIN);
    const tenant = await tenantForUser(user);

    const { rows } = await query(
      `SELECT u.id, u.name, u.email, u.role, u.status, u.note,
              u.requested_at, u.approved_at, u.last_seen_at, u.created_at,
              a.name AS approved_by_name,
              s.name AS stylist_name
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
        stylist: r.stylist_name,
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

      const { rows } = await query(
        `INSERT INTO staff_users (tenant_id, email, password_hash, name, role,
                                  status, approved_at, approved_by)
         VALUES ($1, $2, $3, $4, $5, 'active', now(), $6)
         RETURNING id, name, email, role`,
        [tenant.id, email, await hashPassword(password), name, role, user.id],
      );
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

      default:
        throw new HttpError(400, `"${action}" is not something you can do here.`);
    }

    return json(res, 200, { ok: true, id: target.id, action });
  },
});
