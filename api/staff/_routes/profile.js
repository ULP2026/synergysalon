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
import { assertSameOrigin, canManageTeam, needsOnboarding, requireStaff } from '../../_lib/auth.js';
import { hasColumn, query, transaction } from '../../_lib/db.js';
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

/** The kinds of work, in the order the salon lists them (Skin since 2026-11-13). */
export const SERVICE_KINDS = ['cuts', 'treatments', 'color', 'styling', 'skin'];

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

/** Dollars and cents, or null for none. */
function priceFrom(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10000) throw new HttpError(400, 'A price is a number of dollars, up to 10,000.');
  return Math.round(n * 100) / 100;
}

/** The onboarding steps, in order; the one somebody is on is kept (044). */
export const ONBOARDING_STEPS = ['details', 'services', 'hours', 'calendar', 'review'];

/**
 * A stylist's own services (asked for 2026-11-04), cleaned: a name, which
 * kind it is, an optional description, a price, how long it takes, and
 * whether it is offered. `slug` names one already saved; without it, it is
 * new. The price and minutes are required here, unlike the salon's list:
 * nothing else times or prices a service only one person does.
 */
export function ownServicesFrom(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new HttpError(400, 'Those services are not valid.');
  if (value.length > 30) throw new HttpError(400, 'That is more services than one person can add.');
  return value.map((v) => {
    const name = String(v?.name ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 80) throw new HttpError(400, 'A service needs a name of 2 to 80 characters.');
    if (!SERVICE_KINDS.includes(v?.category)) throw new HttpError(400, `Choose which kind of work ${name} is.`);
    const price = priceFrom(v?.price);
    if (price == null) throw new HttpError(400, `Add a price for ${name}.`);
    const duration = minutesFrom(v?.duration, 5, 720, `${name}'s length`);
    if (duration == null) throw new HttpError(400, `Add how many minutes ${name} takes.`);
    const slug = typeof v?.slug === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(v.slug) ? v.slug : null;
    return {
      slug, name, category: v.category, price, duration, on: v?.on !== false,
      description: String(v?.description ?? '').trim().slice(0, 300),
    };
  });
}

const slugOf = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'service';

/**
 * Write a stylist's own services to the salon's services table, offered only
 * with them (owner_staff_id), and say what each one's slug is. One left out
 * of the list is switched off, not deleted: appointments point at it. A name
 * the salon's list or their own already has is refused, because two
 * services called Haircut is a choice nobody booking can make.
 */
async function saveOwnServices(client, tenantId, userId, list) {
  const { rows: mine } = await client.query(
    'SELECT id, slug FROM services WHERE tenant_id = $1 AND owner_staff_id = $2',
    [tenantId, userId],
  );
  const bySlug = new Map(mine.map((r) => [r.slug, r]));
  const seen = new Set();
  const kept = [];
  for (const svc of list) {
    const key = svc.name.toLowerCase();
    if (seen.has(key)) throw new HttpError(409, `${svc.name} is in your list twice.`);
    seen.add(key);
    const own = svc.slug && bySlug.get(svc.slug);
    const { rows: clash } = await client.query(
      `SELECT 1 FROM services
        WHERE tenant_id = $1 AND active AND lower(name) = $2
          AND (owner_staff_id IS NULL OR owner_staff_id = $3) AND id <> $4`,
      [tenantId, key, userId, own?.id ?? '00000000-0000-0000-0000-000000000000'],
    );
    if (clash[0]) {
      throw new HttpError(409, `There is already a service called ${svc.name}. If it is on the salon's list, tick it there instead.`);
    }
    if (own) {
      await client.query(
        `UPDATE services SET name = $2, category = $3, blurb = $4, duration_min = $5, active = true
          WHERE id = $1`,
        [own.id, svc.name, svc.category, svc.description, svc.duration],
      );
      kept.push({ ...svc, slug: own.slug });
      continue;
    }
    // A slug of its own, never one the website's links use: "own-" and a
    // piece of their id keep it apart from the salon's list.
    const base = `own-${String(userId).slice(0, 6)}-${slugOf(svc.name)}`;
    let slug = base;
    for (let n = 2; n < 50; n += 1) {
      const { rows } = await client.query('SELECT 1 FROM services WHERE tenant_id = $1 AND slug = $2', [tenantId, slug]);
      if (!rows[0]) break;
      slug = `${base}-${n}`;
    }
    // price_cents stays empty as on the salon's list: the stylist's price is
    // in their services object, which is where every stylist's price lives.
    await client.query(
      `INSERT INTO services (tenant_id, slug, name, category, blurb, duration_min, owner_staff_id, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               COALESCE((SELECT MAX(sort_order) + 1 FROM services WHERE tenant_id = $1), 0))`,
      [tenantId, slug, svc.name, svc.category, svc.description, svc.duration, userId],
    );
    kept.push({ ...svc, slug });
  }
  const keep = kept.map((k) => k.slug);
  await client.query(
    `UPDATE services SET active = false
      WHERE tenant_id = $1 AND owner_staff_id = $2 AND active AND NOT (slug = ANY($3::text[]))`,
    [tenantId, userId, keep],
  );
  return { kept, dropped: mine.map((r) => r.slug).filter((sl) => !keep.includes(sl)) };
}

/** Their own services as saved, for the form to show back. */
async function ownServicesOf(tenantId, userId, services) {
  if (!await hasColumn('services', 'owner_staff_id')) return [];
  const { rows } = await query(
    `SELECT slug, name, category, blurb, duration_min FROM services
      WHERE tenant_id = $1 AND owner_staff_id = $2 AND active ORDER BY sort_order`,
    [tenantId, userId],
  );
  return rows.map((r) => {
    const it = services?.items?.[r.slug] || {};
    return {
      slug: r.slug, name: r.name, category: r.category, description: r.blurb || '',
      duration: it.duration ?? r.duration_min, price: it.price ?? null, on: it.on !== false,
    };
  });
}

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
      const highlights = partsFrom(v.highlights, 'Full highlights');
      // Partial Highlights, its own three parts (2026-11-05).
      const partial = partsFrom(v.partial, 'Partial highlights');
      // The three parts are the length; a total typed beside them is not a
      // second opinion.
      duration = total(color) ?? duration;
      out[k] = {
        on, price, duration, ...color,
        highlights: { ...highlights, duration: total(highlights) },
        partial: { ...partial, duration: total(partial) },
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
  // Each service inside a kind (asked for 2026-11-02): whether this person
  // offers it, and how long it takes them. Keyed by the service's slug. A
  // service with no entry is offered whenever its kind is on, as before, so
  // nothing saved earlier changes; a duration here beats the kind's own
  // (timing.js, ownTiming).
  const items = {};
  const srcItems = src.items && typeof src.items === 'object' && !Array.isArray(src.items) ? src.items : {};
  for (const [slug, v] of Object.entries(srcItems).slice(0, 300)) {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug) || !v || typeof v !== 'object') continue;
    const item = { on: v.on !== false, duration: minutesFrom(v.duration, 5, 720, 'A service duration') };
    // A price of its own: a stylist's own services (045) carry one, since
    // nothing else prices them. Beats the kind's price (timing.js, ownPrice).
    const price = priceFrom(v.price);
    if (price != null) item.price = price;
    items[slug] = item;
  }
  out.items = items;
  // The flexible lunch (timing.js): on unless switched off.
  out.lunch = src.lunch !== false;
  return out;
}

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req, null, { onboarding: true });
    // to_jsonb reads the two newer columns without naming them, so this page
    // still loads on a database that has not had migration 011 yet.
    const { rows } = await query(
      `SELECT name, email, phone, role, avatar, created_at, last_seen_at,
              to_jsonb(u) ->> 'username' AS username,
              to_jsonb(u) ->> 'pricing' AS pricing,
              to_jsonb(u) -> 'services' AS services,
              to_jsonb(u) -> 'avatar_style' AS avatar_style,
              COALESCE(to_jsonb(u) ->> 'job_title',
                       (SELECT s.title FROM stylists s WHERE s.staff_user_id = u.id LIMIT 1)) AS job_title,
              (SELECT to_jsonb(s) ->> 'photo' FROM stylists s WHERE s.staff_user_id = u.id LIMIT 1) AS photo,
              (SELECT s.slug FROM stylists s WHERE s.staff_user_id = u.id LIMIT 1) AS stylist_slug,
              (SELECT t.slug FROM tenants t WHERE t.id = u.tenant_id) AS tenant_slug,
              -- Whether their calendar is connected, so their own window opens
              -- showing it rather than offering Connect until a second request
              -- says otherwise. Through to_jsonb, as everywhere else.
              to_jsonb(u) ->> 'google_email' AS google_email,
              to_jsonb(u) ->> 'google_connected_at' AS google_connected_at,
              to_jsonb(u) ->> 'google_ics' AS google_ics,
              to_jsonb(u) ->> 'google_problem' AS google_problem,
              to_jsonb(u) ->> 'onboarding_step' AS onboarding_step
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
      ownServices: await ownServicesOf(user.tenant_id, user.id, me.services),
      avatarStyle: me.avatar_style || null,
      title: me.job_title || '',
      photo: me.photo || (me.stylist_slug ? stylistPhoto(me.tenant_slug, me.stylist_slug) : null),
      hours,
      // Whether they run the team (canManageTeam, the one admin rule). It no
      // longer hides anything: an owner can take appointments too, so their
      // window has services, prices and hours like everybody's.
      admin: canManageTeam(me),
      since: me.created_at,
      lastSeen: me.last_seen_at,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      onboarding: needsOnboarding(user),
      // Where they stopped, so a reload or signing in again picks up there.
      onboardingStep: needsOnboarding(user) && ONBOARDING_STEPS.includes(me.onboarding_step) ? me.onboarding_step : null,
      google: (() => { try { return googleStatus(me); } catch { return undefined; } })(),
    });
  },

  async PATCH(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req, null, { onboarding: true });
    const body = await readJson(req);

    const sets = [];
    const params = [user.id];
    const add = (sql, value) => { params.push(value); sets.push(`${sql} = $${params.length}`); };

    if (body.name !== undefined) add('name', requireString(body.name, 'Name', { max: 120 }));
    // Their job title (043), asked at onboarding; on their chair too, below.
    const title = body.title === undefined ? undefined : String(body.title || '').trim().slice(0, 80);
    if (title !== undefined && await hasColumn('staff_users', 'job_title')) add('job_title', title || null);
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
    // Their lunch break goes with their hours, which they set themselves
    // now (My Settings), so it is saved as sent.
    let services = servicesFrom(body.services);
    // Their own services (045) go into the salon's table, offered only with
    // them, and their on, minutes and price into their services object,
    // where everybody's prices and minutes already live.
    const own = ownServicesFrom(body.ownServices);
    if (own !== undefined && await hasColumn('services', 'owner_staff_id')) {
      const { kept, dropped } = await transaction((client) => saveOwnServices(client, user.tenant_id, user.id, own));
      if (services === undefined) {
        const { rows: cur } = await query('SELECT services FROM staff_users WHERE id = $1', [user.id]);
        services = servicesFrom(cur[0]?.services || {});
      }
      for (const slug of dropped) delete services.items[slug];
      for (const k of kept) services.items[k.slug] = { on: k.on, duration: k.duration, price: k.price };
    }
    if (services !== undefined) add('services', JSON.stringify(services));
    // The onboarding step they are on (044), saved as they move between steps.
    if (body.onboardingStep !== undefined && needsOnboarding(user)
        && ONBOARDING_STEPS.includes(body.onboardingStep) && await hasColumn('staff_users', 'onboarding_step')) {
      add('onboarding_step', body.onboardingStep);
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

    // Everyone sets their own available hours, in My Settings (the salon's
    // decision of 2026-10-15, made on 2026-11-03 when hours and pricing moved
    // there). Until then only the admin could, after guests booked 9 AM with
    // stylists who did not start until later (config.js). What keeps that
    // from coming back: the owner still sees and can change everyone's
    // hours in the Team window, and Appt. Book shows each person's hours,
    // so a wrong rota is visible rather than silently sold.
    const hours = readHours(body.hours);
    // The last step of onboarding (2026-11-03): the account is complete, so
    // the app opens. Checked against what is stored once this save is in, so
    // a stylist cannot finish without the mobile Karen knows them by.
    const finishing = body.finishOnboarding === true && needsOnboarding(user);
    if (!sets.length && !hours && !finishing) throw new HttpError(400, 'Nothing to change.');

    const returning = `RETURNING id, name, email, phone, role, avatar,
                  to_jsonb(staff_users) ->> 'username' AS username,
                  to_jsonb(staff_users) ->> 'pricing' AS pricing,
                  to_jsonb(staff_users) -> 'services' AS services,
                  to_jsonb(staff_users) ->> 'job_title' AS job_title`;
    const { rows } = sets.length
      ? await query(`UPDATE staff_users SET ${sets.join(', ')} WHERE id = $1 ${returning}`, params)
      : await query(`UPDATE staff_users SET name = name WHERE id = $1 ${returning}`, [user.id]);
    // The same as team.js does for somebody else: your services and hours are
    // what make you bookable, so the diary follows the row as saved. Before
    // this, your own window sent hours here and they were thrown away.
    if (services !== undefined || hours || body.name !== undefined || body.username !== undefined || title !== undefined) {
      await transaction((client) => syncStylist(client, user.tenant_id, rows[0], {
        services: rows[0].services, hours, title: rows[0].job_title ?? undefined,
      }));
    }
    if (finishing) {
      const done = rows[0];
      if (!String(done.name || '').trim()) throw new HttpError(400, 'Add your name first.');
      assertStylistPhone(done.role, done.phone);
      // A stylist finishes once they can be booked (2026-11-04): something
      // offered and some hours to offer it in. Anything less opens the app
      // to somebody guests cannot book, which reads as working and is not.
      if (done.role === 'stylist') {
        const { rows: ready } = await query(
          `SELECT EXISTS (SELECT 1 FROM stylist_services x WHERE x.stylist_id = s.id) AS offers,
                  EXISTS (SELECT 1 FROM stylist_hours h WHERE h.stylist_id = s.id) AS hours
             FROM stylists s WHERE s.tenant_id = $1 AND s.staff_user_id = $2 AND s.active`,
          [user.tenant_id, user.id],
        );
        if (!ready[0]?.offers) throw new HttpError(400, 'Switch on at least one service you do.', 'ONBOARDING_SERVICES');
        if (!ready[0]?.hours) throw new HttpError(400, 'Add the hours you are available, on at least one day.', 'ONBOARDING_HOURS');
      }
      if (await hasColumn('staff_users', 'onboarded_at')) {
        await query('UPDATE staff_users SET onboarded_at = now() WHERE id = $1 AND onboarded_at IS NULL', [user.id]);
      }
      if (await hasColumn('staff_users', 'onboarding_step')) {
        await query('UPDATE staff_users SET onboarding_step = NULL WHERE id = $1', [user.id]);
      }
      // Finished: the invite link has nothing left to bring them back to (047).
      if (await hasColumn('staff_users', 'setup_hash')) {
        await query('UPDATE staff_users SET setup_hash = NULL WHERE id = $1', [user.id]);
      }
    }
    const { id, ...out } = rows[0];
    // Their own services as saved, when they sent some: new ones have slugs
    // now, and the page needs them so the next save does not add them again.
    const ownBack = own !== undefined ? { ownServices: await ownServicesOf(user.tenant_id, user.id, rows[0].services) } : {};
    return json(res, 200, { ...out, ...ownBack, saved: true, ...(finishing ? { onboarded: true } : {}) });
  },
});
