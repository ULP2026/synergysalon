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

/** Color & Cut: the color's own parts, then the cut. */
const WITH_CUT = /\bcut\b/i;

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
function parts(p) {
  const start = mins(p?.start, 5, 480);
  const finish = mins(p?.finish, 5, 480);
  if (start == null || finish == null) return null;
  const pause = mins(p?.break, 0, 240) ?? 0;
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
  const own = details?.[service.category];
  if (!own) return null;
  if (service.category === 'color') {
    const color = parts(own);
    if (color && WITH_CUT.test(service.name)) {
      const cut = mins(details?.cuts?.duration, 5, 720);
      return cut ? { durationMin: color.durationMin + cut, breaks: color.breaks } : null;
    }
    if (color) return color;
  }
  const duration = mins(own.duration, 5, 720);
  return duration ? { durationMin: duration, breaks: [] } : null;
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
 * its start: the whole visit with its breaks cut out. `withBuffer` keeps the
 * clean-down at the end, which the diary blocks; the guest's own time, which
 * a Google event must not clash with, leaves it out.
 */
export function workSpans(visit, withBuffer = true) {
  const end = visit.durationMin + (withBuffer ? visit.bufferMin || 0 : 0);
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
