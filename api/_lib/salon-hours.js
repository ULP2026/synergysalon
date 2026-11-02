/**
 * The salon's own opening hours, from the PMC (README.md, Business Facts):
 *
 *   Monday 9a to 3p, Tuesday 9a to 3p, Wednesday 9a to 7p,
 *   Thursday 9a to 7p, Friday 9a to 6p, Saturday 9a to 3p, Sunday closed.
 *
 * Asked for 2026-11-02: Appt. Book's day shows only these hours, and nothing
 * is sold outside them. A stylist's own shift (stylist_hours) still decides
 * when they work, but only inside the salon's day: a shift typed as 8 to 8
 * is offered 9 to 3 on a Monday, and nobody is offered on a Sunday. Without
 * this, one wrong shift in Team sold times the salon is shut, which is how
 * online booking came to be paused on 30 September.
 *
 * Keyed by tenant slug, like GOOGLE_OPTIONAL_STYLISTS, because these are
 * Synergy's hours and the second salon will have its own. A salon not listed
 * here has no opening hours on record, and its stylists' shifts decide alone,
 * as before. Weekdays count Sunday as 0, as stylist_hours does.
 *
 * Change these here when the salon changes its hours, and in the PMC, the
 * schema.org openingHoursSpecification of every public page, and Karen's
 * APP_GUIDE (karen-knowledge.js), so the site, the app and Karen agree.
 */
export const SALON_HOURS = {
  synergy: {
    0: null,
    1: ['09:00', '15:00'],
    2: ['09:00', '15:00'],
    3: ['09:00', '19:00'],
    4: ['09:00', '19:00'],
    5: ['09:00', '18:00'],
    6: ['09:00', '15:00'],
  },
};

const mins = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
};
const hhmm = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

/**
 * The salon's day as [opens, closes] in minutes past midnight, `null` for a
 * day it is closed, or `undefined` when the salon has no hours on record.
 */
export function salonHoursOn(tenant, weekday) {
  const week = SALON_HOURS[tenant?.slug];
  if (!week) return undefined;
  const day = week[weekday];
  return day ? [mins(day[0]), mins(day[1])] : null;
}

/**
 * Stylist shifts (rows with starts_at and ends_at as 'HH:MM[:SS]') cut to the
 * salon's day. A shift wholly outside it goes; a closed day leaves none.
 */
export function clampShifts(shifts, salon) {
  if (salon === undefined) return shifts;
  if (salon === null) return [];
  return shifts.flatMap((sh) => {
    const a = Math.max(salon[0], mins(sh.starts_at));
    const b = Math.min(salon[1], mins(sh.ends_at));
    return b > a ? [{ ...sh, starts_at: hhmm(a), ends_at: hhmm(b) }] : [];
  });
}

/** The same for shifts held as [start, end] minutes (the day view's). */
export function clampSpans(spans, salon) {
  if (salon === undefined) return spans;
  if (salon === null) return [];
  return spans
    .map(([a, b]) => [Math.max(salon[0], a), Math.min(salon[1], b)])
    .filter(([a, b]) => b > a);
}
