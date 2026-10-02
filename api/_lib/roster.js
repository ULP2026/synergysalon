/**
 * One list of people, not two.
 *
 * The console has always shown a team: who works here, what they do, what they
 * charge. The booking engine has always read a separate `stylists` table, with
 * its own hours and its own services, maintained by hand in SQL. A salon owner
 * was being asked to keep two lists in step without being told the second one
 * existed, which is why all four stylists ended up deactivated and the booking
 * page had nobody to offer.
 *
 * So the team is the list. A member who takes appointments gets a stylists row
 * linked back to them by staff_user_id -- a column the schema has carried from
 * the start for this purpose. Nothing about the booking side changes: the
 * exclusion constraint, stylist_hours and appointments all still hang off
 * stylists, because moving them would risk double-booking to gain nothing a
 * guest would ever see.
 *
 * Retiring somebody deactivates that row rather than deleting it. Appointments
 * point at it, and a past booking has to keep saying who did the work.
 */
import { HttpError } from './http.js';

/** The four switches in the team dialog are the four service categories. */
export const SERVICE_KINDS = ['cuts', 'treatments', 'color', 'styling'];

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** At most this many separate shifts in one day: a morning, an afternoon, an
 *  evening. More than that is a typo rather than a rota. */
const MAX_SHIFTS_PER_DAY = 3;

/**
 * Weekly hours, validated.
 *
 * Returns [{ weekday, starts, ends }] sorted, or throws with a message meant
 * for whoever typed it. Overlapping shifts on one day are rejected rather than
 * merged: they almost always mean two rows were meant to be different days,
 * and silently merging hides that.
 */
export function readHours(value) {
  if (value == null) return null;              // not submitted: leave alone
  if (!Array.isArray(value)) throw new HttpError(400, 'Those hours are not valid.');
  if (value.length > 7 * MAX_SHIFTS_PER_DAY) throw new HttpError(400, 'That is too many shifts.');

  const out = [];
  for (const row of value) {
    const weekday = Number(row?.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new HttpError(400, 'Those hours name a day that does not exist.');
    }
    const starts = String(row?.starts ?? '').trim();
    const ends = String(row?.ends ?? '').trim();
    if (!TIME.test(starts) || !TIME.test(ends)) {
      throw new HttpError(400, 'Times need to look like 09:00.');
    }
    if (ends <= starts) {
      throw new HttpError(400, 'A shift has to end after it starts.');
    }
    out.push({ weekday, starts, ends });
  }

  out.sort((a, b) => a.weekday - b.weekday || a.starts.localeCompare(b.starts));
  for (let i = 1; i < out.length; i += 1) {
    const prev = out[i - 1];
    const here = out[i];
    if (here.weekday === prev.weekday && here.starts < prev.ends) {
      throw new HttpError(400, 'Two shifts on the same day overlap.');
    }
  }
  const perDay = new Map();
  for (const row of out) perDay.set(row.weekday, (perDay.get(row.weekday) ?? 0) + 1);
  for (const n of perDay.values()) {
    if (n > MAX_SHIFTS_PER_DAY) throw new HttpError(400, 'That is too many shifts in one day.');
  }
  return out;
}

/** A slug that is stable, readable and free within this salon. */
async function freeSlug(client, tenantId, wanted, stylistId) {
  const base = String(wanted || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 40) || 'stylist';
  for (let n = 0; n < 50; n += 1) {
    const slug = n ? `${base}-${n + 1}` : base;
    const { rows } = await client.query(
      'SELECT id FROM stylists WHERE tenant_id = $1 AND slug = $2',
      [tenantId, slug],
    );
    if (!rows[0] || rows[0].id === stylistId) return slug;
  }
  throw new HttpError(409, 'Could not find a free booking name for them.');
}

/** The services they offer, as ids, from the categories they switched on. */
async function serviceIdsFor(client, tenantId, kinds) {
  if (!kinds.length) return [];
  const { rows } = await client.query(
    `SELECT id FROM services
      WHERE tenant_id = $1 AND active AND category = ANY($2::text[])`,
    [tenantId, kinds],
  );
  return rows.map((r) => r.id);
}

/**
 * Bring the booking side into line with one team member.
 *
 * `services` is the object the team dialog already sends: { cuts: { on, price } }.
 * `hours` is null when the caller did not touch them, which is not the same as
 * an empty array -- that means "they work no fixed hours", and clears the lot.
 *
 * Returns the stylist row, or null when this person does not take appointments.
 */
export async function syncStylist(client, tenantId, user, { services, hours, title } = {}) {
  const kinds = SERVICE_KINDS.filter((k) => services?.[k]?.on);
  const takesAppointments = kinds.length > 0;

  const { rows: found } = await client.query(
    'SELECT id, slug, active FROM stylists WHERE tenant_id = $1 AND staff_user_id = $2',
    [tenantId, user.id],
  );
  let stylist = found[0] ?? null;

  if (!takesAppointments) {
    // Off the booking page, still on the team. Their past work keeps its name.
    if (stylist?.active) {
      await client.query('UPDATE stylists SET active = false WHERE id = $1', [stylist.id]);
    }
    return null;
  }

  if (!stylist) {
    const slug = await freeSlug(client, tenantId, user.username || user.name, null);
    const { rows } = await client.query(
      `INSERT INTO stylists (tenant_id, slug, name, title, staff_user_id, active, sort_order)
       VALUES ($1, $2, $3, $4, $5, true,
               COALESCE((SELECT MAX(sort_order) + 1 FROM stylists WHERE tenant_id = $1), 0))
       RETURNING id, slug, active`,
      [tenantId, slug, user.name, String(title || '').slice(0, 120), user.id],
    );
    stylist = rows[0];
  } else {
    await client.query(
      `UPDATE stylists SET name = $2, active = true,
              title = COALESCE($3, title)
        WHERE id = $1`,
      [stylist.id, user.name, title == null ? null : String(title).slice(0, 120)],
    );
  }

  // Services: replace wholesale. Working out the difference would save two
  // statements and cost the certainty that the table says what the switches say.
  const ids = await serviceIdsFor(client, tenantId, kinds);
  await client.query('DELETE FROM stylist_services WHERE stylist_id = $1', [stylist.id]);
  if (ids.length) {
    await client.query(
      `INSERT INTO stylist_services (stylist_id, service_id)
       SELECT $1, unnest($2::uuid[])`,
      [stylist.id, ids],
    );
  }

  if (hours) {
    await client.query('DELETE FROM stylist_hours WHERE stylist_id = $1', [stylist.id]);
    if (hours.length) {
      await client.query(
        `INSERT INTO stylist_hours (stylist_id, weekday, starts_at, ends_at)
         SELECT $1, w, s::time, e::time
           FROM unnest($2::int[], $3::text[], $4::text[]) AS t(w, s, e)`,
        [stylist.id, hours.map((h) => h.weekday), hours.map((h) => h.starts), hours.map((h) => h.ends)],
      );
    }
  }

  return stylist;
}

/** The weekly hours for a team member, for the dialog to show. */
export async function hoursFor(client, tenantId, staffUserId) {
  const { rows } = await client.query(
    `SELECT h.weekday,
            to_char(h.starts_at, 'HH24:MI') AS starts,
            to_char(h.ends_at, 'HH24:MI') AS ends
       FROM stylist_hours h
       JOIN stylists s ON s.id = h.stylist_id
      WHERE s.tenant_id = $1 AND s.staff_user_id = $2
      ORDER BY h.weekday, h.starts_at`,
    [tenantId, staffUserId],
  );
  return rows;
}
