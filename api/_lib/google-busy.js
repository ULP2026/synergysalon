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
       FROM stylists s JOIN staff_users u ON u.id = s.staff_user_id
      WHERE s.id = ANY($1::uuid[])
        AND ((to_jsonb(u) ->> 'google_refresh_token') IS NOT NULL
             OR (to_jsonb(u) ->> 'google_ics') IS NOT NULL)`,
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
