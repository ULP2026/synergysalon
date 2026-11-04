/**
 * Google busy times for the stylists a guest might be offered.
 *
 * The Synergy Calendar (this database) is what decides availability; a
 * stylist with no Google Calendar is booked from it alone. A stylist who has
 * connected one is also not offered online while Google says they are busy,
 * so a guest cannot book the hour of their own appointment elsewhere.
 *
 * Read the same two ways as Appt. Book's columns (diary.js): the sign-in
 * first when the site has Google's client, the pasted private address
 * otherwise. Times only, never what the events are.
 *
 * When a connected calendar cannot be read, that stylist is reported as
 * unreachable and the caller offers them nothing online: the salon chose to
 * miss a booking over risking a clash. Answers are kept for a minute per warm
 * function, because the booking survey asks for the same month repeatedly.
 */
import { GOOGLE_OPTIONAL_STYLISTS } from './config.js';
import { busyBetween, googleConfigured } from './google.js';
import { icsBusyBetween, openLink } from './google-ics.js';

const TTL_MS = 60_000;
const cache = new Map();   // key -> { at, value }

/** Swapped out by the tests, which have no Google to talk to. */
let reader = async (row, fromIso, toIso, zone) => {
  if (row.signed_in && googleConfigured()) return busyBetween(row.staff_user_id, fromIso, toIso);
  if (row.google_ics) return icsBusyBetween(openLink(row.google_ics), fromIso, toIso, zone);
  return null;
};
export function setGoogleReaderForTests(fn) { reader = fn; cache.clear(); }

/** Slugs of this salon's stylists offered online without a Google Calendar. */
export function googleOptional(tenant) {
  return GOOGLE_OPTIONAL_STYLISTS[tenant?.slug] ?? [];
}

/**
 * Whether a team login has a Google Calendar connected, as SQL on a
 * staff_users row aliased `u`. Through to_jsonb, so it still runs before
 * migrations 010 and 018.
 *
 * Online booking offers only stylists for whom this holds (the salon's rule):
 * somebody added to the app who has not connected their calendar could be
 * busy at any hour the salon cannot see, so a guest is not shown them at all.
 * The desk still books anyone, and the salon's current stylists are let
 * through without one (googleOptional).
 */
/**
 * Whose login a chair belongs to, as a condition on a stylists row `s` and
 * a staff_users row `u`. The chair's own link (staff_user_id), or, for a
 * chair with no login, the active login with the same first name when no
 * other chair without a login shares it and that login has no chair of its
 * own (2026-11-04). Dina is the reason: she signs in as Owner (owners get no
 * chair, or her services would vanish), connected her Google Calendar to that
 * login, and is booked in the separate "Dina Lara" chair the website links
 * to. Without this her Google busy time never reached her chair, her
 * bookings were never copied to her Google Calendar, her column on Appt.
 * Book could not book with her, and her chair's visits were left off it.
 */
export const chairLoginSql = (s = 's', u = 'u') => `(${u}.id = ${s}.staff_user_id OR (
      ${s}.staff_user_id IS NULL AND ${s}.active AND (to_jsonb(${s}) ->> 'removed_at') IS NULL
      AND ${u}.tenant_id = ${s}.tenant_id AND ${u}.status = 'active'
      AND lower(split_part(btrim(${u}.name), ' ', 1)) = lower(split_part(btrim(${s}.name), ' ', 1))
      AND NOT EXISTS (SELECT 1 FROM stylists x WHERE x.staff_user_id = ${u}.id AND x.active)
      AND NOT EXISTS (SELECT 1 FROM stylists y WHERE y.tenant_id = ${s}.tenant_id AND y.id <> ${s}.id
                        AND y.staff_user_id IS NULL AND y.active
                        AND lower(split_part(btrim(y.name), ' ', 1)) = lower(split_part(btrim(${s}.name), ' ', 1)))))`;

/** The login a chair belongs to (see chairLoginSql), as a LATERAL join aliased `alias`. */
export const chairLoginJoin = (s = 's', alias = 'u') => `LEFT JOIN LATERAL (
      SELECT cu.* FROM staff_users cu WHERE ${chairLoginSql(s, 'cu')}
       ORDER BY (cu.id = ${s}.staff_user_id) DESC NULLS LAST LIMIT 1) ${alias} ON true`;

export const GOOGLE_CONNECTED_SQL = `((to_jsonb(u) ->> 'google_refresh_token') IS NOT NULL
             OR (to_jsonb(u) ->> 'google_ics') IS NOT NULL)`;

/**
 * Map of stylist id -> [[fromMs, toMs], ...] for each connected stylist, or
 * the string 'unreachable'. Stylists without a connected calendar are absent.
 */
export async function googleBusyFor(client, stylistIds, fromIso, toIso, zone) {
  const out = new Map();
  if (!stylistIds.length) return out;
  // Through to_jsonb, so this still runs before migrations 010 and 018.
  const { rows } = await client.query(
    `SELECT s.id AS stylist_id, u.id AS staff_user_id,
            (to_jsonb(u) ->> 'google_refresh_token') IS NOT NULL AS signed_in,
            to_jsonb(u) ->> 'google_ics' AS google_ics
       FROM stylists s ${chairLoginJoin('s', 'u')}
      WHERE s.id = ANY($1::uuid[]) AND u.id IS NOT NULL AND ${GOOGLE_CONNECTED_SQL}`,
    [stylistIds],
  ).catch(() => ({ rows: [] }));

  await Promise.all(rows.map(async (row) => {
    const key = `${row.staff_user_id}|${fromIso}|${toIso}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) { out.set(row.stylist_id, hit.value); return; }
    let value;
    try {
      const busy = await reader(row, fromIso, toIso, zone);
      value = busy == null ? 'unreachable'
        : busy.map((b) => [new Date(b.startsAt).getTime(), new Date(b.endsAt).getTime()]);
    } catch (err) {
      console.error('google busy for availability failed', row.staff_user_id, err.message);
      value = 'unreachable';
    }
    // Failures are not cached, so the next ask tries Google again.
    if (value !== 'unreachable') cache.set(key, { at: Date.now(), value });
    out.set(row.stylist_id, value);
  }));
  return out;
}
