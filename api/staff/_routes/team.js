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
import { randomBytes, createHash } from 'node:crypto';

import { query, transaction } from '../../_lib/db.js';
import { hoursFor, readHours, syncStylist } from '../../_lib/roster.js';
import { sendInvite } from '../../_lib/email.js';
import {
  HttpError, handler, json, readJson, requireEmail, requireString,
} from '../../_lib/http.js';
import { MIN_PASSWORD_LENGTH, hashPassword } from '../../_lib/password.js';
import { stylistPhoto } from '../../_lib/stylist-photos.js';
import { tenantForUser } from '../../_lib/tenant.js';
import {
  assertUsernameFree, avatarFrom, avatarStyleFrom, servicesFrom, usernameFrom,
} from './profile.js';

const ADMIN = ['owner', 'manager'];
const ROLES = ['owner', 'manager', 'front_desk'];

/** How long an invite is good for. Long enough for a day off, short enough
 * that a forwarded link does not sit live for a month. */
const INVITE_DAYS = 7;

/**
 * A fresh invite for somebody, returned as the raw link.
 *
 * Only the hash is kept, exactly as with a session token: a copy of this table
 * is not a set of working invites. The raw token exists for the length of this
 * request and is then only in the email and on the screen of whoever added
 * them, so they can hand it over directly if the email does not arrive.
 */
async function mintInvite(req, userId) {
  const token = randomBytes(32).toString('base64url');
  await query(
    `UPDATE staff_users
        SET invite_hash = $2,
            invite_expires_at = now() + make_interval(days => $3::int),
            invited_at = now()
      WHERE id = $1`,
    [userId, createHash('sha256').update(token).digest('hex'), INVITE_DAYS],
  );
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  return `${proto}://${host}/staff/invite?t=${token}`;
}

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req, ADMIN);
    const tenant = await tenantForUser(user);

    const { rows } = await query(
      // username and pricing through to_jsonb, so the team still lists on a
      // database that has not had migration 011 yet.
      `SELECT u.id, u.name, u.email, u.role, u.status, u.note, u.avatar,
              u.requested_at, u.approved_at, u.last_seen_at, u.created_at,
              (to_jsonb(u) ->> 'invite_hash') IS NOT NULL AS invited,
              to_jsonb(u) ->> 'username' AS username,
              to_jsonb(u) ->> 'pricing' AS pricing,
              to_jsonb(u) -> 'services' AS services,
              to_jsonb(u) -> 'avatar_style' AS avatar_style,
              to_jsonb(s) ->> 'photo' AS photo,
              a.name AS approved_by_name,
              s.name AS stylist_name, s.slug AS stylist_slug, s.title AS stylist_title,
              -- Bookable is not a column anyone sets: it is whether this person
              -- has a live stylist row, which switching a service on creates.
              COALESCE(s.active, false) AS bookable,
              COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                 'weekday', h.weekday,
                                 'starts', to_char(h.starts_at, 'HH24:MI'),
                                 'ends', to_char(h.ends_at, 'HH24:MI'))
                               ORDER BY h.weekday, h.starts_at)
                          FROM stylist_hours h WHERE h.stylist_id = s.id), '[]'::jsonb) AS hours
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
        // Added but never signed in: their invite is still outstanding.
        invited: r.invited,
        // Whether a guest can book them, and when.
        bookable: r.bookable,
        hours: r.hours ?? [],
        name: r.name,
        email: r.email,
        role: r.role,
        status: r.status,
        note: r.note,
        avatar: r.avatar,
        username: r.username || '',
        pricing: r.pricing || '',
        services: r.services || {},
        avatarStyle: r.avatar_style || null,
        photo: r.photo || (r.stylist_slug ? stylistPhoto(tenant.slug, r.stylist_slug) : null),
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

      // No password is chosen for them. The column cannot be null, so it holds
      // a hash of something nobody has: it can never be guessed, and it can
      // never verify, so the account is unusable until the invite is accepted.
      const unusable = await hashPassword(randomBytes(32).toString('base64url'));
      const { rows } = await query(
        `INSERT INTO staff_users (tenant_id, email, password_hash, name, role,
                                  status, approved_at, approved_by, invited_by)
         VALUES ($1, $2, $3, $4, $5, 'active', now(), $6, $6)
         RETURNING id, name, email, role`,
        [tenant.id, email, unusable, name, role, user.id],
      );
      // The profile extras go in a second statement so adding a person still
      // works on a database that has not had migration 011; only the extras
      // need it.
      if (avatar) await query('UPDATE staff_users SET avatar = $2 WHERE id = $1', [rows[0].id, avatar]);
      const style = avatarStyleFrom(body.avatarStyle);
      if (style) await query('UPDATE staff_users SET avatar_style = $2::jsonb WHERE id = $1', [rows[0].id, style]);
      if (username || pricing) {
        await query('UPDATE staff_users SET username = $2, pricing = $3 WHERE id = $1',
          [rows[0].id, username, pricing]);
      }
      const services = servicesFrom(body.services);
      if (services) {
        await query('UPDATE staff_users SET services = $2::jsonb WHERE id = $1',
          [rows[0].id, JSON.stringify(services)]);
      }
      // The team is the list. Switching a service on is what makes somebody
      // bookable, so the booking side is brought into line in the same breath
      // rather than left for a separate screen nobody knows to visit.
      await transaction((client) => syncStylist(client, tenant.id, {
        id: rows[0].id, name, username,
      }, { services, hours: readHours(body.hours), title: body.title }));
      const link = await mintInvite(req, rows[0].id);
      // Sending is a courtesy, not the mechanism. No email provider, a typo in
      // the address, a spam folder -- the person adding them still has the
      // link on screen and can hand it over directly.
      let emailed = false;
      try {
        const r = await sendInvite({ name, email, link, expiresDays: INVITE_DAYS }, tenant);
        emailed = !r?.skipped;
      } catch (err) {
        console.error('invite email failed for', email, err);
      }

      return json(res, 201, { ok: true, member: rows[0], invite: { link, emailed, expiresDays: INVITE_DAYS } });
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
      case 'reinvite': {
        // Only for an account that has never been used. Re-inviting somebody
        // who already has a password would be a way to take their account
        // over, which is what the password reset they do themselves is for.
        const { rows: who } = await query(
          'SELECT id, name, email, invite_hash FROM staff_users WHERE id = $1 AND tenant_id = $2',
          [id, tenant.id],
        );
        if (!who[0]) throw new HttpError(404, 'That person is not on this team.');
        if (!who[0].invite_hash) {
          throw new HttpError(409, `${who[0].name} has already set a password.`);
        }
        const link = await mintInvite(req, id);
        let emailed = false;
        try {
          const r = await sendInvite(
            { name: who[0].name, email: who[0].email, link, expiresDays: INVITE_DAYS }, tenant);
          emailed = !r?.skipped;
        } catch (err) { console.error('invite email failed for', who[0].email, err); }
        return json(res, 200, { ok: true, invite: { link, emailed, expiresDays: INVITE_DAYS } });
      }

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
        const services = servicesFrom(body.services);
        if (services !== undefined) add('services', JSON.stringify(services));
        const avatar = avatarFrom(body.avatar);
        if (avatar !== undefined) add('avatar', avatar);
        const style = avatarStyleFrom(body.avatarStyle);
        if (style !== undefined) add('avatar_style', style);
        if (body.role !== undefined) {
          if (!ROLES.includes(body.role)) throw new HttpError(400, 'That is not a role.');
          if (body.role === 'owner' && user.role !== 'owner') {
            throw new HttpError(403, 'Only an owner can make someone else an owner.');
          }
          add('role', body.role);
        }
        const hours = readHours(body.hours);
        if (!sets.length && !hours) throw new HttpError(400, 'Nothing to change.');
        if (sets.length) {
          await query(`UPDATE staff_users SET ${sets.join(', ')} WHERE id = $1`, params);
        }
        // Read back rather than reasoning about what changed: the booking side
        // should follow the row that now exists, not the patch that was sent.
        const { rows: after } = await query(
          `SELECT id, name, to_jsonb(u) ->> 'username' AS username,
                  to_jsonb(u) -> 'services' AS services
             FROM staff_users u WHERE id = $1`,
          [target.id],
        );
        await transaction((client) => syncStylist(client, tenant.id, after[0], {
          services: after[0].services, hours, title: body.title,
        }));
        break;
      }

      default:
        throw new HttpError(400, `"${action}" is not something you can do here.`);
    }

    return json(res, 200, { ok: true, id: target.id, action });
  },
});
