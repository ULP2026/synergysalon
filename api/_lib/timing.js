/**
 * How long a service really takes, and which parts of it the stylist works.
 *
 * Each service has a length in the services table, one figure for the whole
 * salon and every one an industry estimate (db/seed.sql). Each stylist also
 * types their own figures in their team window, one per kind of work, and
 * for color and highlights three of them: Start (applying it), Break (it
 * processes; the stylist is free for somebody else) and Finish (rinse, tone,
 * style). Those are the stylist saying how long the work takes when they do
 * it, so they decide the booking; the table's figure is used only where the
 * stylist has not typed one.
 *
 * A visit's length is then its parts end to end, breaks and the clean-downs
 * between them included, and what blocks the stylist's diary is that length
 * with the breaks cut out. The database compares the same thing
 * (appointment_blocks() in migration 025), so this file and the constraint
 * must agree on what a break is: [minutes from the start, minutes long].
 */

/** Within Color, the services timed by the Highlights figures. */
const HIGHLIGHTS = /highlight|balayage|foil/i;

/** Color & Cut: the cut, then the color's own parts. */
const WITH_CUT = /\bcut\b/i;

/**
 * Color & Cut as the salon runs it (asked for 2026-10-20): cut 45, apply the
 * color 45, let it process at least 45 while the stylist takes somebody
 * else, then 45 to rinse and finish. The cut comes first because colour is
 * rinsed and styled last; cutting after would undo the finish. These stand
 * in for any figure the stylist has not typed, so a Color & Cut always has
 * its processing break: the table's single 180 minutes held the stylist for
 * all of it.
 */
export const COLOR_AND_CUT = { cut: 45, start: 45, break: 45, finish: 45 };

/**
 * Single Process Color the same way without the cut (asked for 2026-10-20):
 * apply 45, process 45 with the stylist free, finish 45. Its table figure of
 * 90 had no break and held the stylist the whole time.
 */
const SINGLE_PROCESS = /single[\s-]process/i;

const mins = (v, lo, hi) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};

/** Which of a stylist's figures a service is timed by. */
export function timingKey(service) {
  if (service.category === 'color' && HIGHLIGHTS.test(`${service.slug} ${service.name}`)) return 'highlights';
  return service.category;
}

/**
 * Start, Break and Finish as one service's timing, or null when Start or
 * Finish is missing: a color with no stated finish is not a timing at all,
 * and guessing its end would sell time the stylist does not have.
 */
function parts(p, minBreak = 0) {
  const start = mins(p?.start, 5, 480);
  const finish = mins(p?.finish, 5, 480);
  if (start == null || finish == null) return null;
  const pause = Math.max(mins(p?.break, 0, 240) ?? 0, minBreak);
  return {
    durationMin: start + pause + finish,
    breaks: pause ? [[start, pause]] : [],
  };
}

/**
 * A stylist's own timing for one service, or null to use the table's.
 * `details` is their services object ({ color: { start, break, finish,
 * highlights: {...}, duration }, cuts: { duration }, ... }).
 */
export function ownTiming(details, service) {
  const key = timingKey(service);
  if (key === 'highlights') return parts(details?.color?.highlights);
  if (key === 'color' && WITH_CUT.test(service.name)) return colorAndCut(details);
  if (key === 'color' && SINGLE_PROCESS.test(`${service.slug} ${service.name}`)) {
    return parts(details?.color, COLOR_AND_CUT.break) ?? parts(COLOR_AND_CUT);
  }
  const own = details?.[service.category];
  if (!own) return null;
  if (service.category === 'color') {
    const color = parts(own);
    if (color) return color;
  }
  const duration = mins(own.duration, 5, 720);
  return duration ? { durationMin: duration, breaks: [] } : null;
}

/**
 * Color & Cut: the stylist's Cuts time, then their Color parts, the salon's
 * figures for whichever they have not typed. The processing break is never
 * shorter than the salon's 45: color left less than that is not finished,
 * and a longer one only frees the stylist for longer.
 */
function colorAndCut(details) {
  const cut = mins(details?.cuts?.duration, 5, 720) ?? COLOR_AND_CUT.cut;
  const color = parts(details?.color, COLOR_AND_CUT.break) ?? parts(COLOR_AND_CUT);
  return {
    durationMin: cut + color.durationMin,
    breaks: color.breaks.map(([at, len]) => [cut + at, len]),
  };
}

/** One service as this stylist does it: its length and its breaks. */
export function timedService(service, details) {
  const own = ownTiming(details, service);
  return {
    ...service,
    duration_min: own ? own.durationMin : service.duration_min,
    breaks: own ? own.breaks : [],
  };
}

/**
 * The parts of a visit the stylist is working, as [from, to] in minutes from
 * its start: the guest's own time with the processing breaks cut out. This
 * is what the diary draws -- the Start, the Break left open, then the Finish
 * (apptCard in staff/index.html) -- and what the database's no-overlap
 * constraint compares (migration 027).
 *
 * It is the guarantee, and a narrow one on purpose: two guests are never in
 * the same chair at the same time, whatever races the code above it loses.
 * The station turnaround between appointments is a different kind of claim
 * and is answered by cleanDown() below, in availability.js, where it can
 * take account of what the time is being taken out of.
 */
export function workSpans(visit) {
  const end = visit.durationMin;
  const out = [];
  let t = 0;
  for (const [at, len] of [...(visit.breaks || [])].sort((a, b) => a[0] - b[0])) {
    if (at > t) out.push([t, Math.min(at, end)]);
    t = Math.max(t, at + len);
  }
  if (end > t) out.push([t, end]);
  return out.filter(([a, b]) => b > a);
}

/**
 * The station turnaround after a visit: the one [from, to] span a caller can
 * add to workSpans(), or nothing when the service has none.
 *
 * Kept apart from the working time because it is not the same kind of thing.
 * The working time is a fact about a guest -- they are in that chair -- and
 * the database enforces it. This is the salon's own scheduling, and whether
 * it holds a slot depends on what the slot is cut out of: between two
 * appointments it does, because the station really has to be turned round,
 * and inside another appointment's processing break it does not, because the
 * stylist is only borrowed and goes back to a guest who never left.
 * availability.js draws that distinction. Nothing here can: it takes two
 * appointments to know.
 */
export function cleanDown(visit) {
  const len = visit.bufferMin || 0;
  return len ? [[visit.durationMin, visit.durationMin + len]] : [];
}

/**
 * Breaks as stored, cleaned: whole minutes, inside the visit, in order. What
 * the database is given has to be something the constraint can trust.
 */
export function cleanBreaks(breaks, durationMin) {
  if (!Array.isArray(breaks)) return [];
  return breaks
    .map((b) => [Number(b?.[0]), Number(b?.[1])])
    .filter(([at, len]) => Number.isInteger(at) && Number.isInteger(len)
      && at > 0 && len > 0 && at + len < durationMin)
    .sort((a, b) => a[0] - b[0]);
}

/**
 * The flexible lunch (asked for 2026-10-31): 30 minutes, somewhere between
 * 11:00 and 1:00, wherever the bookings leave room. It has no fixed place:
 * a booking may take the time it happens to be sitting in, and the lunch
 * moves, as long as 30 minutes of that window are still free afterwards.
 * Each stylist's switch is `lunch` in their own settings (the same object
 * as their service times); it is on unless switched off.
 */
export const LUNCH = { from: 11 * 60, to: 13 * 60, minutes: 30 };

export function flexLunchOn(details) {
  return details?.lunch !== false;
}

/**
 * The earliest start of `len` free units inside any of `windows`, given the
 * `taken` spans, or null when there is none. Units are whatever the caller
 * uses (minutes for the grid, milliseconds for availability).
 */
export function lunchGap(windows, taken, len) {
  const busy = [...taken].sort((a, b) => a[0] - b[0]);
  for (const [ws, we] of windows) {
    let t = ws;
    for (const [s, e] of busy) {
      if (e <= t) continue;
      if (s >= we) break;
      if (s - t >= len) return t;
      t = Math.max(t, e);
    }
    if (we - t >= len) return t;
  }
  return null;
}
