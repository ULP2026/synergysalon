/**
 * The salon's working day, from its own team's hours.
 *
 * Asked for 2026-11-02, twice. First Appt. Book's day was cut to the hours in
 * Synergy's PMC (Mon, Tue, Sat 9 to 3 and so on), kept here as a constant.
 * Then the salon asked for the day to follow the hours the team actually
 * sets: a stylist working 9 to 6 on Monday puts 9 to 6 on Monday's grid, and
 * 9 to 3 on Tuesday gives Tuesday 9 to 3. A constant per salon could not do
 * that, and could not serve a second salon either, so the day is now read
 * from stylist_hours (the same rows availability.js offers times from, set
 * by the admin in Settings, Team): from the earliest anyone starts to the
 * latest anyone finishes. A day nobody works is closed.
 *
 * Nothing here cuts what can be booked: a stylist's own hours already do
 * that in availableSlots, and the salon's day is only their sum.
 */

/** [earliest start, latest end] in minutes over every span given, or null when there are none. */
export function daySpan(spans) {
  const all = (spans || []).filter((s) => Array.isArray(s) && s[1] > s[0]);
  if (!all.length) return null;
  return [Math.min(...all.map((s) => s[0])), Math.max(...all.map((s) => s[1]))];
}

const mins = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
};

/**
 * The salon's week from its active team's hours, Sunday first: each day's
 * [opens, closes] in minutes, or null for a day nobody works. Null as a
 * whole when nobody has any hours yet, so a salon still setting up is not
 * shown as closed every day.
 */
export async function salonWeek(db, tenantId) {
  const { rows } = await db.query(
    `SELECT h.weekday, to_char(h.starts_at, 'HH24:MI') AS opens, to_char(h.ends_at, 'HH24:MI') AS closes
       FROM stylist_hours h
       JOIN stylists s ON s.id = h.stylist_id
      WHERE s.tenant_id = $1::uuid AND s.active
        AND (to_jsonb(s) ->> 'removed_at') IS NULL`,
    [tenantId],
  );
  if (!rows.length) return null;
  return [0, 1, 2, 3, 4, 5, 6].map((w) => daySpan(rows
    .filter((r) => Number(r.weekday) === w)
    .map((r) => [mins(r.opens), mins(r.closes)])));
}
