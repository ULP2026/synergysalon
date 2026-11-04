/**
 * /api/staff/team: who has access, and who is asking for it.
 *
 *   GET    the team, pending requests first
 *   POST   add someone, edit their details, approve, reject, remove for
 *          good (delete), disable, re-enable, or change a role
 *
 * Everybody on the team can read the team (name, picture, email, phone,
 * role, services, hours): the salon asked that colleagues can look each
 * other up. Changing anything is POST, and POST is the owner and the
 * agency's support login only (canManageTeam), so nobody can grant
 * themselves access or edit a colleague; their own account goes through
 * /api/staff/profile. What only the admin needs (requests to join, invite
 * state, notes, who approved whom, which Google account) is left out of a
 * non-admin's copy.
 */
import {
  assertSameOrigin, canManageTeam, requireStaff, requireTeamAdmin, TEAM_ADMIN_ROLES,
} from '../../_lib/auth.js';
import { randomBytes, createHash } from 'node:crypto';

import { query, transaction } from '../../_lib/db.js';
import { ensureSchema } from '../../_lib/ensure-schema.js';
import {
  hoursFor, listStandalone, readHours, syncStandalone, syncStylist,
} from '../../_lib/roster.js';
import { sendInvite } from '../../_lib/email.js';
import { textInvite } from '../../_lib/sms-notify.js';
import {
  HttpError, handler, json, readJson, requireEmail, requireString,
} from '../../_lib/http.js';
import { MIN_PASSWORD_LENGTH, hashPassword } from '../../_lib/password.js';
import { stylistPhoto } from '../../_lib/stylist-photos.js';
import { tenantForUser } from '../../_lib/tenant.js';
import { googleStatus } from './calendars.js';
import { moveAppointment } from './appointment.js';
import {
  assertStylistPhone, assertUsernameFree, avatarFrom, avatarStyleFrom, phoneFrom, servicesFrom, usernameFrom,
} from './profile.js';

const ROLES = ['owner', 'admin', 'manager', 'front_desk', 'stylist'];

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
  // The app's own host has no /staff in its addresses (vercel.json).
  return `${proto}://${host}${host.startsWith('app.') ? '' : '/staff'}/invite?t=${token}`;
}

/**
 * Karen's welcome to somebody invited, by email and by text, and what came
 * of each for the confirmation window: `emailed`, `texted`, whether the
 * email was refused (`emailFailed`), and `off` when the owner has switched
 * the Team Member Invitation automation off. Never throws: the account and
 * its link exist either way, and the window then shows the link to hand on.
 */
export async function deliverInvite(tenant, { id, name, email, phone, link, invitedBy }, deps = {}) {
  const sendMail = deps.sendInvite || sendInvite;
  const sendSms = deps.textInvite || textInvite;
  let emailed = false;
  let emailFailed = false;
  let off = false;
  try {
    const r = await sendMail({ name, email, link, expiresDays: INVITE_DAYS, invitedBy }, tenant);
    emailed = !r?.skipped;
    off = Boolean(r?.off);
  } catch (err) {
    emailFailed = true;
    console.error('invite email failed for', email, err);
  }
  const t = await sendSms({ tenant, phone, name, link, expiresDays: INVITE_DAYS, staffUserId: id });
  return {
    link, emailed, emailFailed, texted: t.texted === true, textFailed: Boolean(t.failed),
    hasPhone: String(phone || '').replace(/\D/g, '').length >= 10, off, expiresDays: INVITE_DAYS,
  };
}

/**
 * What is still to come in a chair: booked visits that have not started.
 * Past visits stay where they were, under the name of whoever did them.
 */
export async function upcomingIn(tenantId, stylistIds) {
  if (!stylistIds.length) return [];
  const { rows } = await query(
    `SELECT a.ref, a.starts_at, a.guest_name, s.slug AS stylist_slug, s.name AS stylist_name,
            COALESCE(v.name, 'Appointment') AS service_name
       FROM appointments a
       JOIN stylists s ON s.id = a.stylist_id
       LEFT JOIN services v ON v.id = a.service_id
      WHERE a.tenant_id = $1::uuid AND a.stylist_id = ANY($2::uuid[])
        AND a.status = 'booked' AND a.starts_at > now()
      ORDER BY a.starts_at`,
    [tenantId, stylistIds],
  );
  return rows.map((r) => ({
    ref: r.ref, startsAt: r.starts_at, client: r.guest_name, service: r.service_name,
    stylist: r.stylist_name, stylistSlug: r.stylist_slug,
  }));
}

/**
 * Move every visit still to come from one chair to another, each at its own
 * time (asked for 2026-11-04, after a removed stylist's clients were left in
 * a chair nobody works). Each goes through moveAppointment, the desk's own
 * move: the new stylist must offer the service and be free then, within
 * their hours, and the no-overlap rule has the last word, so nothing is
 * double-booked. One that cannot move stays where it is and is returned with
 * why, for the owner to place by hand or send to somebody else. The client
 * is told of the change only when `notify` (the move's own choice).
 */
export async function reassignChair(tenant, user, { from, to, notify = true, refs = null }, deps = {}) {
  const move = deps.move || moveAppointment;
  const { rows: chairs } = await query(
    `SELECT id, slug, name, active FROM stylists WHERE tenant_id = $1::uuid AND slug = ANY($2::text[])`,
    [tenant.id, [from, to]],
  );
  const src = chairs.find((c) => c.slug === from);
  const dst = chairs.find((c) => c.slug === to);
  if (!src) throw new HttpError(404, 'That stylist is not on this salon.');
  if (!dst || !dst.active) throw new HttpError(400, 'Choose a stylist who is on the team and takes bookings.');
  if (src.id === dst.id) throw new HttpError(400, 'Choose a different stylist to move them to.');
  let list = await upcomingIn(tenant.id, [src.id]);
  if (Array.isArray(refs)) list = list.filter((a) => refs.includes(a.ref));
  const moved = [];
  const skipped = [];
  for (const a of list) {
    try {
      await move(tenant, user, a.ref, { start: new Date(a.startsAt).toISOString(), stylist: dst.slug, notify });
      moved.push(a);
    } catch (err) {
      skipped.push({ ...a, reason: err instanceof HttpError ? err.message : 'It could not be moved.' });
      if (!(err instanceof HttpError)) console.error('reassign failed for', a.ref, err);
    }
  }
  return { from: src.name, to: dst.name, moved, skipped };
}

/**
 * Before anybody is removed (2026-11-04): what is still booked in their
 * chair goes to another stylist first (`reassignTo`, a slug), or the owner
 * says plainly to keep it there (`keepAppointments`), to move one by one on
 * Appt. Book. Otherwise the removal is refused with the list, so a client
 * is never left booked with somebody who no longer works there without the
 * owner having chosen it. A visit that cannot move stops the removal, with
 * the reasons; the ones that did move stay moved.
 */
async function guardUpcoming(tenant, user, body, stylistIds, name) {
  const { rows: slugs } = stylistIds.length
    ? await query('SELECT slug FROM stylists WHERE id = ANY($1::uuid[])', [stylistIds]) : { rows: [] };
  const upcoming = await upcomingIn(tenant.id, stylistIds);
  if (!upcoming.length || body.keepAppointments === true) return;
  if (!body.reassignTo) {
    const err = new HttpError(409, `${name} still has ${upcoming.length} upcoming appointment${upcoming.length === 1 ? '' : 's'}. `
      + 'Choose who takes them before removing them.', 'HAS_APPOINTMENTS');
    err.extra = { upcoming };
    throw err;
  }
  const skipped = [];
  for (const { slug } of slugs) {
    const out = await reassignChair(tenant, user, { from: slug, to: String(body.reassignTo), notify: body.notify !== false });
    skipped.push(...out.skipped);
  }
  if (skipped.length) {
    const err = new HttpError(409, `${skipped.length} appointment${skipped.length === 1 ? '' : 's'} could not move, so ${name} was not removed. `
      + 'The others have moved. Place these on Appt. Book, or choose another stylist.', 'REASSIGN_INCOMPLETE');
    err.extra = { upcoming: skipped };
    throw err;
  }
}

export default handler({
  async GET(req, res) {
    // The Team list and removals read stylists.removed_at (022); the live
    // database gets its columns here rather than from db:migrate.
    await ensureSchema();
    const user = await requireStaff(req);
    const admin = canManageTeam(user);
    // The Team is Salon Settings: the owner's only (2026-11-03). Everyone
    // else keeps their own account in My Settings (/api/staff/profile).
    if (!admin) throw new HttpError(403, 'Only the salon owner can see the team.');
    const tenant = await tenantForUser(user);

    const { rows } = await query(
      // username and pricing through to_jsonb, so the team still lists on a
      // database that has not had migration 011 yet.
      `SELECT u.id, u.name, u.email, u.phone, u.role, u.status, u.note, u.avatar,
              u.requested_at, u.approved_at, u.last_seen_at, u.created_at,
              (to_jsonb(u) ->> 'invite_hash') IS NOT NULL AS invited,
              -- Still to finish setting up their account (042).
              (to_jsonb(u) ? 'onboarded_at') AND (to_jsonb(u) ->> 'onboarded_at') IS NULL AS onboarding,
              to_jsonb(u) ->> 'username' AS username,
              to_jsonb(u) ->> 'pricing' AS pricing,
              to_jsonb(u) -> 'services' AS services,
              to_jsonb(u) -> 'avatar_style' AS avatar_style,
              to_jsonb(s) ->> 'photo' AS photo,
              -- Through to_jsonb, so the team still lists before migration 010.
              to_jsonb(u) ->> 'google_email' AS google_email,
              (to_jsonb(u) ->> 'google_refresh_token') IS NOT NULL AS google_connected,
              to_jsonb(u) ->> 'google_connected_at' AS google_connected_at,
              to_jsonb(u) ->> 'google_ics' AS google_ics,
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

    // Stylists who take appointments but never sign in. They are on the same
    // list because from a salon's point of view they are the same thing: a
    // person in a chair that a guest can book.
    // With the salon's portrait, as everywhere else a stylist's face appears.
    // Only the owner sees the team (asked for 2026-11-03): everybody else
    // sees their own account and nobody else's, here as on Appt. Book.
    const standalone = admin ? (await listStandalone({ query }, tenant.id))
      .map((st) => ({ ...st, photo: stylistPhoto(tenant.slug, st.stylistSlug) })) : [];

    const visible = admin ? rows : rows.filter((r) => r.id === user.id);
    const members = visible.map((r) => ({
        id: r.id,
        // Added but never signed in: their invite is still outstanding.
        invited: r.invited,
        // Signed in but still setting up their account (onboarding).
        onboarding: Boolean(r.onboarding) && !canManageTeam(r),
        // Whether a guest can book them, and when.
        bookable: r.bookable,
        hours: r.hours ?? [],
        name: r.name,
        email: r.email,
        phone: r.phone || '',
        role: r.role,
        // Whether they run the team (canManageTeam in auth.js). It no longer
        // hides their services, prices or hours: an owner can be a stylist.
        admin: canManageTeam(r),
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
        // Connect your tools: whether their Google Calendar is linked, and as
        // whom. Never the tokens.
        google: googleStatus(r),
        title: r.stylist_title || '',
        requestedAt: r.requested_at,
        approvedAt: r.approved_at,
        approvedBy: r.approved_by_name,
        lastSeenAt: r.last_seen_at,
      }));
    if (!admin) {
      for (const m of members) {
        // Their own row keeps everything; it is theirs.
        if (m.id === user.id) continue;
        delete m.invited; delete m.note; delete m.requestedAt; delete m.approvedAt;
        delete m.approvedBy; delete m.lastSeenAt;
        m.google = { available: m.google.available, connected: m.google.connected, via: null, account: null, since: null };
      }
    }

    return json(res, 200, {
      you: { id: user.id, role: user.role, canManageTeam: admin },
      pending: admin ? rows.filter((r) => r.status === 'pending').length : 0,
      standalone,
      members,
    });
  },

  async POST(req, res) {
    assertSameOrigin(req);
    await ensureSchema();
    const user = await requireTeamAdmin(req);
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
      if (TEAM_ADMIN_ROLES.includes(role) && !canManageTeam(user)) {
        throw new HttpError(403, 'Only an owner can make someone else an owner.');
      }
      assertStylistPhone(role, phoneFrom(body.phone));

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
      const phone = phoneFrom(body.phone);
      if (phone) await query('UPDATE staff_users SET phone = $2 WHERE id = $1', [rows[0].id, phone]);
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
      // Karen's welcome (the Team Member Invitation automation, 2026-11-04):
      // an email, kept in Email History, and a text to their mobile, kept for
      // the automation's Sent History, both leading them to the setup she
      // walks them through. Switched off in Automations, neither goes and the
      // owner is handed the link instead.
      const invite = await deliverInvite(tenant, { id: rows[0].id, name, email, phone: phoneFrom(body.phone), link, invitedBy: user.name });
      return json(res, 201, { ok: true, member: rows[0], invite });
    }

    // Moving a chair's upcoming visits to somebody else, by slug: also for
    // a chair already removed, whose login no longer exists.
    if (action === 'reassign') {
      const out = await reassignChair(tenant, user, {
        from: requireString(body.from, 'From', { max: 80 }),
        to: requireString(body.to, 'Stylist', { max: 80 }),
        notify: body.notify !== false,
        refs: Array.isArray(body.refs) ? body.refs.map(String).slice(0, 500) : null,
      });
      return json(res, 200, { ok: true, ...out });
    }
    if (action === 'upcoming') {
      const from = requireString(body.from, 'From', { max: 80 });
      const { rows: ch } = await query('SELECT id, name FROM stylists WHERE tenant_id = $1::uuid AND slug = $2::text', [tenant.id, from]);
      if (!ch[0]) throw new HttpError(404, 'That stylist is not on this salon.');
      return json(res, 200, { ok: true, name: ch[0].name, upcoming: await upcomingIn(tenant.id, [ch[0].id]) });
    }

    const id = requireString(body.id, 'Member', { max: 64 });

    // "st_<uuid>" is a stylist with no login. They have no role, no password
    // and no session, so none of the access rules below apply to them -- only
    // what they do and when.
    if (id.startsWith('st_')) {
      if (action === 'delete') {
        await guardUpcoming(tenant, user, body, [id.slice(3)], 'This stylist');
        // Removed for good, like anybody else: off the team and the website.
        // The row itself stays, switched off and marked removed, because
        // appointments point at it and past work keeps its name.
        const { rowCount } = await query(
          `UPDATE stylists SET active = false, removed_at = now()
            WHERE id = $1::uuid AND tenant_id = $2::uuid AND staff_user_id IS NULL`,
          [id.slice(3), tenant.id],
        );
        if (!rowCount) throw new HttpError(404, 'That stylist is not on this team.');
        return json(res, 200, { ok: true, id, action });
      }
      if (action !== 'update') throw new HttpError(400, 'That cannot be done to a stylist without a login.');
      const saved = await transaction((client) => syncStandalone(
        client, tenant.id, id.slice(3),
        { services: servicesFrom(body.services), hours: readHours(body.hours) },
      ));
      return json(res, 200, { ok: true, id, action, bookable: saved.bookable });
    }

    const { rows } = await query(
      'SELECT id, name, email, role, status, phone FROM staff_users WHERE id = $1 AND tenant_id = $2',
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
          'SELECT id, name, email, phone, invite_hash FROM staff_users WHERE id = $1 AND tenant_id = $2',
          [id, tenant.id],
        );
        if (!who[0]) throw new HttpError(404, 'That person is not on this team.');
        if (!who[0].invite_hash) {
          throw new HttpError(409, `${who[0].name} has already set a password.`);
        }
        const link = await mintInvite(req, id);
        const invite = await deliverInvite(tenant, { ...who[0], link, invitedBy: user.name });
        return json(res, 200, { ok: true, invite });
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

      // Removing somebody from the team, for good. Asked for in place of
      // turning the account off, which left people on the list.
      //
      // Their stylist row is kept but switched off first: appointments point
      // at it, so past and booked work keeps their name, and a stylist with
      // no login otherwise counts as bookable, which would leave the person
      // just removed still taking online bookings. Everything else that
      // points at the login lets go by itself: sessions and calendar tokens
      // are deleted with it, and "booked by" or "approved by" become empty.
      case 'delete': {
        if (target.role === 'owner' && !canManageTeam(user)) {
          throw new HttpError(403, 'Only an owner can remove another owner.');
        }
        {
          const { rows: theirs } = await query(
            'SELECT id FROM stylists WHERE staff_user_id = $1::uuid AND tenant_id = $2::uuid', [target.id, tenant.id],
          );
          await guardUpcoming(tenant, user, body, theirs.map((r) => r.id), target.name);
        }
        try {
          await transaction(async (client) => {
            // Marked removed as well as switched off: with the login gone the
            // row has no staff_user_id, and without the mark the Team list
            // took it for a stylist who never signs in and showed the person
            // just removed again on the next load.
            await client.query(
              `UPDATE stylists SET active = false, removed_at = now()
                WHERE staff_user_id = $1::uuid AND tenant_id = $2::uuid`,
              [target.id, tenant.id],
            );
            // Their own services (045) go off with them: nobody else does
            // them, and with no owner left they must not become the salon's.
            // Kept, not deleted, because appointments point at them.
            await client.query('SAVEPOINT own');
            try {
              await client.query(
                `UPDATE services SET active = false
                  WHERE owner_staff_id = $1::uuid AND tenant_id = $2::uuid`,
                [target.id, tenant.id],
              );
              await client.query('RELEASE SAVEPOINT own');
            } catch {
              await client.query('ROLLBACK TO SAVEPOINT own');   // before 045: nothing of theirs to switch off
            }
            await client.query(
              'DELETE FROM staff_users WHERE id = $1::uuid AND tenant_id = $2::uuid',
              [target.id, tenant.id],
            );
          });
        } catch (err) {
          // Something added outside the migrations still points at them with
          // no rule for letting go. Nothing was changed (it is one
          // transaction), so say so rather than half-removing them.
          if (err.code === '23503') {
            console.error('team delete blocked by', err.constraint, err.table);
            throw new HttpError(409, `${target.name} is still linked to other records, so they were not removed. `
              + 'Nothing was changed. Please let support know.');
          }
          throw err;
        }
        break;
      }

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
        if (TEAM_ADMIN_ROLES.includes(role) && !canManageTeam(user)) {
          throw new HttpError(403, 'Only an owner can make someone else an owner.');
        }
        assertStylistPhone(role, target.phone);
        await query('UPDATE staff_users SET role = $2 WHERE id = $1', [target.id, role]);
        break;
      }

      // The team modal: name, email, phone, username, pricing and picture together.
      // Each is changed only when sent, so a field nobody touched is left as
      // it was.
      case 'update': {
        if (target.role === 'owner' && !canManageTeam(user)) {
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
        if (body.phone !== undefined) add('phone', phoneFrom(body.phone));
        // Whatever role they end up with, a stylist leaves with a mobile number.
        assertStylistPhone(body.role ?? target.role, body.phone !== undefined ? phoneFrom(body.phone) : target.phone);
        if (body.username !== undefined) {
          const username = usernameFrom(body.username);
          await assertUsernameFree(tenant.id, username, target.id);
          add('username', username);
        }
        if (body.pricing !== undefined) add('pricing', String(body.pricing || '').trim().slice(0, 120));
        // Owners and admins included: an owner can be a stylist too, and with
        // every service off is simply not on the booking page (syncStylist).
        const services = servicesFrom(body.services);
        if (services !== undefined) add('services', JSON.stringify(services));
        const avatar = avatarFrom(body.avatar);
        if (avatar !== undefined) add('avatar', avatar);
        const style = avatarStyleFrom(body.avatarStyle);
        if (style !== undefined) add('avatar_style', style);
        if (body.role !== undefined) {
          if (!ROLES.includes(body.role)) throw new HttpError(400, 'That is not a role.');
          if (TEAM_ADMIN_ROLES.includes(body.role) && !canManageTeam(user)) {
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
