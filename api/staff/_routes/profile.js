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
import { assertSameOrigin, canManageTeam, requireStaff } from '../../_lib/auth.js';
import { query, transaction } from '../../_lib/db.js';
import { hoursFor, readHours, syncStylist } from '../../_lib/roster.js';
import {
  HttpError, handler, json, readJson, requireEmail, requireString,
} from '../../_lib/http.js';
import { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from '../../_lib/password.js';
import { stylistPhoto } from '../../_lib/stylist-photos.js';
import { googleStatus } from './calendars.js';

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
  // One of the built-in avatars (assets/avatars), stored as its path.
  if (/^\/assets\/avatars\/[a-z_]{3,40}\.png$/.test(s)) return s;
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

/**
 * A phone number as typed, trimmed, or '' to clear it. Not reformatted: the
 * team reads it back as they wrote it, and nothing dials it yet.
 */
export function phoneFrom(value) {
  const s = String(value ?? '').trim().slice(0, 40);
  if (s && !/^[0-9+().\-\s]{7,40}$/.test(s)) {
    throw new HttpError(400, 'A phone number is digits, spaces, dashes, dots, brackets or a plus.');
  }
  return s;
}

/**
 * A stylist's mobile number is required (asked for 2026-10-28): it is how
 * Karen knows a text is from them and not a client, and so what lets a
 * stylist move or cancel their clients' appointments by text. Ten digits,
 * the area code included. Other roles may leave it empty.
 */
export function assertStylistPhone(role, phone) {
  if (role === 'stylist' && String(phone || '').replace(/\D/g, '').length < 10) {
    throw new HttpError(400, 'A stylist needs a mobile number with the area code: it is how Karen knows a text is from them.');
  }
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

/**
 * A character's settings from the maker: short strings and on/off flags,
 * nothing else, and small. The browser draws from them; the server only
 * keeps them so the same character can be opened again.
 */
export function avatarStyleFrom(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'That character could not be saved.');
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 30)) {
    if (!/^[a-zA-Z]{1,20}$/.test(k)) continue;
    if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && /^[#a-z0-9]{1,20}$/i.test(v)) out[k] = v;
  }
  return JSON.stringify(out);
}

/** Pricing describes how a stylist charges; owners and managers set it. */
const CAN_PRICE = ['owner', 'admin', 'manager'];

/** The four kinds of work, in the order the salon lists them. */
export const SERVICE_KINDS = ['cuts', 'treatments', 'color', 'styling'];

const minutesFrom = (v, lo, hi, what) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) {
    throw new HttpError(400, `${what} is a whole number of minutes, from ${lo} to ${hi}.`);
  }
  return n;
};

/** Start, Break and Finish, or nulls; a Break needs a Start and a Finish around it. */
function partsFrom(p, label) {
  const src = p && typeof p === 'object' ? p : {};
  const start = minutesFrom(src.start, 5, 480, `${label} Start`);
  const pause = minutesFrom(src.break, 0, 240, `${label} Break`);
  const finish = minutesFrom(src.finish, 5, 480, `${label} Finish`);
  if (pause && (start == null || finish == null)) {
    throw new HttpError(400, `${label} needs a Start and a Finish around its Break.`);
  }
  return { start, break: pause, finish };
}

const total = (p) => (p.start != null && p.finish != null ? p.start + (p.break || 0) + p.finish : null);

/**
 * A stylist's services and prices, cleaned: only the four known kinds, each
 * on or off, with a price in dollars and a length in minutes, and one set of
 * notes for clients shared by them all. Anything else is dropped rather than
 * stored, so the column only ever holds what the form can show back.
 *
 * Color is timed in three parts, Start, Break and Finish, once for color and
 * once for highlights, because the stylist is free for somebody else while
 * it processes; its length is then the three added up. These lengths are the
 * stylist's own and decide how long a guest is booked with them for
 * (timing.js); a kind left blank falls back to each service's own length in
 * the services table.
 *
 * Notes used to be typed per service. They are one box now, asked for on
 * 2026-10-17; notes saved the old way are carried into it rather than lost.
 */
export function servicesFrom(value) {
  if (value === undefined) return undefined;
  const out = {};
  const src = value && typeof value === 'object' ? value : {};
  for (const k of SERVICE_KINDS) {
    const v = src[k] || {};
    const on = Boolean(v.on);
    let price = v.price === '' || v.price == null ? null : Number(v.price);
    if (price != null && (!Number.isFinite(price) || price < 0 || price > 10000)) {
      throw new HttpError(400, 'A price is a number of dollars, up to 10,000.');
    }
    if (price != null) price = Math.round(price * 100) / 100;
    let duration = minutesFrom(v.duration, 5, 720, 'A duration');
    if (k === 'color') {
      const color = partsFrom(v, 'Color');
      const highlights = partsFrom(v.highlights, 'Highlights');
      // The three parts are the length; a total typed beside them is not a
      // second opinion.
      duration = total(color) ?? duration;
      out[k] = {
        on, price, duration, ...color,
        highlights: { ...highlights, duration: total(highlights) },
      };
    } else {
      out[k] = { on, price, duration };
    }
  }
  let notes = typeof src.notes === 'string' ? src.notes : null;
  if (notes == null) {
    // Saved before the shared box: each service's own notes, labelled.
    notes = SERVICE_KINDS
      .map((k) => (typeof src[k]?.notes === 'string' && src[k].notes.trim()
        ? `${k[0].toUpperCase()}${k.slice(1)}: ${src[k].notes.trim()}` : ''))
      .filter(Boolean).join('\n');
  }
  out.notes = notes.trim().slice(0, 2000);
  return out;
}

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req);
    // to_jsonb reads the two newer columns without naming them, so this page
    // still loads on a database that has not had migration 011 yet.
    const { rows } = await query(
      `SELECT name, email, phone, role, avatar, created_at, last_seen_at,
              to_jsonb(u) ->> 'username' AS username,
              to_jsonb(u) ->> 'pricing' AS pricing,
              to_jsonb(u) -> 'services' AS services,
              to_jsonb(u) -> 'avatar_style' AS avatar_style,
              (SELECT to_jsonb(s) ->> 'photo' FROM stylists s WHERE s.staff_user_id = u.id LIMIT 1) AS photo,
              (SELECT s.slug FROM stylists s WHERE s.staff_user_id = u.id LIMIT 1) AS stylist_slug,
              (SELECT t.slug FROM tenants t WHERE t.id = u.tenant_id) AS tenant_slug,
              -- Whether their calendar is connected, so their own window opens
              -- showing it rather than offering Connect until a second request
              -- says otherwise. Through to_jsonb, as everywhere else.
              to_jsonb(u) ->> 'google_email' AS google_email,
              to_jsonb(u) ->> 'google_connected_at' AS google_connected_at,
              to_jsonb(u) ->> 'google_ics' AS google_ics
         FROM staff_users u WHERE id = $1`,
      [user.id],
    );
    const me = rows[0];
    if (!me) throw new HttpError(404, 'That account no longer exists.');
    // Your own hours and calendar, the same as an owner sees them on your
    // card in the team list. Without these your own window opened with every
    // day off, and saving it wrote nothing to the diary.
    const hours = await hoursFor({ query }, user.tenant_id, user.id);
    return json(res, 200, {
      name: me.name,
      email: me.email,
      phone: me.phone,
      role: me.role,
      avatar: me.avatar,
      username: me.username || '',
      pricing: me.pricing || '',
      services: me.services || {},
      avatarStyle: me.avatar_style || null,
      photo: me.photo || (me.stylist_slug ? stylistPhoto(me.tenant_slug, me.stylist_slug) : null),
      hours,
      // Whether they run the team (canManageTeam, the one admin rule). It no
      // longer hides anything: an owner can take appointments too, so their
      // window has services, prices and hours like everybody's.
      admin: canManageTeam(me),
      since: me.created_at,
      lastSeen: me.last_seen_at,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      google: (() => { try { return googleStatus(me); } catch { return undefined; } })(),
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
      const phone = phoneFrom(body.phone);
      assertStylistPhone(user.role, phone);
      add('phone', phone);
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
    const style = avatarStyleFrom(body.avatarStyle);
    if (style !== undefined) add('avatar_style', style);

    if (body.username !== undefined) {
      const username = usernameFrom(body.username);
      await assertUsernameFree(user.tenant_id, username, user.id);
      add('username', username);
    }
    // Everybody sets their own prices: they are the one quoting them. The
    // owner too, who can be a stylist as well as run the place; with every
    // service off they are simply not on the booking page (syncStylist).
    const services = servicesFrom(body.services);
    if (services !== undefined) add('services', JSON.stringify(services));
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

    // Working hours are the admin's to set, from the team (team.js) for
    // everybody else and here for their own. A stylist's own hours sent here
    // are ignored, so the stored rota stands.
    const hours = canManageTeam(user) ? readHours(body.hours) : null;
    if (!sets.length && !hours) throw new HttpError(400, 'Nothing to change.');

    const returning = `RETURNING id, name, email, phone, role, avatar,
                  to_jsonb(staff_users) ->> 'username' AS username,
                  to_jsonb(staff_users) ->> 'pricing' AS pricing,
                  to_jsonb(staff_users) -> 'services' AS services`;
    const { rows } = sets.length
      ? await query(`UPDATE staff_users SET ${sets.join(', ')} WHERE id = $1 ${returning}`, params)
      : await query(`UPDATE staff_users SET name = name WHERE id = $1 ${returning}`, [user.id]);
    // The same as team.js does for somebody else: your services and hours are
    // what make you bookable, so the diary follows the row as saved. Before
    // this, your own window sent hours here and they were thrown away.
    if (body.services !== undefined || hours || body.name !== undefined || body.username !== undefined) {
      await transaction((client) => syncStylist(client, user.tenant_id, rows[0], {
        services: rows[0].services, hours,
      }));
    }
    const { id, ...out } = rows[0];
    return json(res, 200, { ...out, saved: true });
  },
});
