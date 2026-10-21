/**
 * Works out which slots a salon can actually honour.
 *
 * Availability is computed on the salon's own wall clock and returned as
 * instants. Doing it the other way round breaks twice a year: a slot grid
 * built in UTC drifts an hour when the clocks change, and the salon starts
 * offering 08:00 appointments in November. The timezone comes from the
 * tenant, not a constant, because the second salon will not be in Florida.
 *
 * What this never does is decide whether a booking succeeds. It reports what
 * looks free; the database has the final say, because between reading this
 * list and pressing Book, somebody else may have taken the slot.
 */
import { DateTime, Interval } from 'luxon';

import { MAX_ADVANCE_DAYS, MIN_LEAD_MIN, SLOT_STEP_MIN } from './config.js';
import { googleBusyFor, googleOptional } from './google-busy.js';
import { HttpError } from './http.js';
import { cleanBreaks, cleanDown, timedService, workSpans } from './timing.js';

/** Luxon counts Monday as 1 and Sunday as 7; the schema counts Sunday as 0. */
function weekdayOf(dt) {
  return dt.weekday % 7;
}

export async function loadService(client, tenantId, slug) {
  const { rows } = await client.query(
    `SELECT id, slug, name, category, blurb, duration_min, buffer_min,
            price_cents, consult_first
       FROM services WHERE tenant_id = $1 AND slug = $2 AND active`,
    [tenantId, slug],
  );
  if (!rows.length) throw new HttpError(404, 'That service is not available.');
  return rows[0];
}

/**
 * One visit made of several services, booked as a single appointment with one
 * stylist: the guest's time is every service end to end, with each one's
 * clean-down between them, and the last clean-down after. Priced only when
 * every part has a price, because a total with a hole in it is a guess.
 *
 * A service's processing breaks (timedService in timing.js) keep their place
 * inside it, moved along by whatever came before, so a color booked after a
 * cut still frees its stylist while it develops.
 *
 * A cut booked with a color goes first, whichever was picked first: the
 * color is rinsed and finished last (the salon's order, 2026-10-20), and a
 * cut after it would undo the finish.
 */
export function combineServices(primary, extras = []) {
  const given = [primary, ...extras];
  const all = given.some((v) => v.category === 'color')
    ? [...given.filter((v) => v.category === 'cuts'), ...given.filter((v) => v.category !== 'cuts')]
    : given;
  const last = all[all.length - 1];
  const breaks = [];
  let t = 0;
  all.forEach((v, i) => {
    for (const [at, len] of v.breaks || []) breaks.push([t + at, len]);
    t += v.duration_min + (i < all.length - 1 ? v.buffer_min || 0 : 0);
  });
  const priced = all.every((v) => v.price_cents != null);
  return {
    durationMin: t,
    bufferMin: last.buffer_min || 0,
    priceCents: priced ? all.reduce((t, v) => t + v.price_cents, 0) : null,
    names: all.map((v) => v.name),
    breaks: cleanBreaks(breaks, t),
  };
}

/**
 * Stylists who are active, offer this service, and (if someone specific was
 * asked for) are that person.
 */
async function loadStylists(client, tenantId, serviceId, stylistSlug) {
  // Their own figures for how long each kind of work takes (timing.js): a
  // team member's are in staff_users.services, a stylist without a sign-in's
  // in stylists.service_details. Through to_jsonb, so this still runs on a
  // database without either column.
  const { rows } = await client.query(
    `SELECT s.id, s.slug, s.name, s.title, s.sort_order,
            COALESCE(to_jsonb(u) -> 'services', to_jsonb(s) -> 'service_details', '{}'::jsonb) AS details
       FROM stylists s
       JOIN stylist_services ss ON ss.stylist_id = s.id
       LEFT JOIN staff_users u ON u.id = s.staff_user_id
      WHERE s.tenant_id = $1 AND s.active AND ss.service_id = $2
        AND ($3::text IS NULL OR s.slug = $3)
      ORDER BY s.sort_order`,
    [tenantId, serviceId, stylistSlug ?? null],
  );
  if (!rows.length) {
    throw new HttpError(404, stylistSlug
      ? 'That stylist does not offer this service.'
      : 'No stylist currently offers this service.');
  }
  return rows;
}

/**
 * The picture of a window -- working hours, existing bookings and time off --
 * in the three queries it takes rather than one per day.
 */
async function loadWindow(client, tenantId, stylistIds, windowStart, windowEnd, excludeId) {
  const range = `[${windowStart.toISO()},${windowEnd.toISO()})`;

  const [hours, booked, off] = await Promise.all([
    client.query(
      `SELECT stylist_id, weekday, starts_at, ends_at
         FROM stylist_hours WHERE stylist_id = ANY($1)`,
      [stylistIds],
    ),
    // The appointment in three pieces, because the slot check needs all
    // three: how long the guest is there, the turnaround after them, and the
    // processing breaks inside it that somebody else may have. Through
    // to_jsonb for the breaks, so this still reads a database that has not
    // had migration 025.
    client.query(
      `SELECT stylist_id, starts_at AS from_ts, duration_min, buffer_min,
              to_jsonb(a) -> 'breaks' AS breaks
         FROM appointments a
        WHERE status = 'booked' AND stylist_id = ANY($1) AND during && $2::tstzrange
          AND ($3::uuid IS NULL OR id <> $3)`,
      [stylistIds, range, excludeId ?? null],
    ),
    client.query(
      `SELECT stylist_id, lower(during) AS from_ts, upper(during) AS to_ts
         FROM time_off
        WHERE tenant_id = $1 AND during && $2::tstzrange
          AND (stylist_id IS NULL OR stylist_id = ANY($3))`,
      [tenantId, range, stylistIds],
    ),
  ]);

  const busy = new Map(stylistIds.map((id) => [id, []]));
  const closed = [];   // salon-wide, applies to everyone

  // Each entry is one thing in the stylist's day: what it occupies, and the
  // holes inside it that somebody else may genuinely have. Kept whole rather
  // than flattened into a list of spans, because whether a turnaround may run
  // into something depends on which thing it is running into.
  for (const row of booked.rows) {
    const from = +row.from_ts;
    const ms = (min) => from + min * 60_000;
    const breaks = cleanBreaks(row.breaks, row.duration_min);
    const visit = { durationMin: row.duration_min, bufferMin: row.buffer_min, breaks };
    busy.get(row.stylist_id)?.push({
      spans: [...workSpans(visit), ...cleanDown(visit)].map(([a, b]) => [ms(a), ms(b)]),
      breaks: breaks.map(([at, len]) => [ms(at), ms(at + len)]),
    });
  }
  for (const row of off.rows) {
    const span = [+row.from_ts, +row.to_ts];
    // Time off has no holes in it: lunch is not a processing break.
    if (row.stylist_id === null) closed.push(span);
    else busy.get(row.stylist_id)?.push({ spans: [span], breaks: [] });
  }

  const shifts = new Map(stylistIds.map((id) => [id, []]));
  for (const row of hours.rows) shifts.get(row.stylist_id)?.push(row);

  return { shifts, busy, closed };
}

function overlapsAny(startMs, endMs, spans) {
  for (const [from, to] of spans) {
    if (startMs < to && endMs > from) return true;
  }
  return false;
}

/**
 * Slots between two dates, as
 *   [{ date: '2026-10-01', slots: [{ start: ISO, stylists: [slug, ...] }] }]
 *
 * A slot appears once with the stylists free for it, so the caller can offer
 * "first available" without asking the server again.
 *
 * `excludeAppointmentId` leaves one booking out of the busy set. Rescheduling
 * needs it: an appointment must not block the guest from nudging it fifteen
 * minutes later, which is the move people make most.
 *
 * `minLeadMin` is overridable because a member of staff on the phone with
 * someone standing in reception may legitimately book them in now, while a
 * guest booking online at midnight may not.
 *
 * `google` takes a connected stylist's Google busy times out as well
 * (google-busy.js), and offers nothing for one whose calendar cannot be read.
 * Guests get it; the desk does not, for the same reason as above.
 *
 * `length` ({ durationMin, bufferMin, breaks }) is an existing appointment's
 * own, for moving it.
 *
 * `visits` maps each stylist's id to the visit as they would do it
 * (timing.js): its length, clean-down, price and processing breaks. A slot is
 * offered with a stylist only where the parts they would be working are free.
 *
 * `extraServiceSlugs` are the visit's other services: the slot must fit all
 * of them end to end (combineServices) with one stylist who offers each.
 */
export async function availableSlots(client, tenant, {
  serviceSlug, stylistSlug, fromDate, toDate, extraServiceSlugs = [],
  excludeAppointmentId = null, minLeadMin = MIN_LEAD_MIN,
  google = false, length = null,
}) {
  const zone = tenant.timezone;
  const service = await loadService(client, tenant.id, serviceSlug);
  // The other services of the same visit: the stylist has to offer every one
  // of them, and the slot has to fit them all.
  const extras = [];
  for (const slug of [...new Set(extraServiceSlugs)].filter((x) => x && x !== serviceSlug).slice(0, 5)) {
    extras.push(await loadService(client, tenant.id, slug));
  }
  let stylists = await loadStylists(client, tenant.id, service.id, stylistSlug);
  if (extras.length) {
    const { rows } = await client.query(
      `SELECT stylist_id FROM stylist_services
        WHERE stylist_id = ANY($1::uuid[]) AND service_id = ANY($2::uuid[])
        GROUP BY stylist_id HAVING count(DISTINCT service_id) = $3::int`,
      [stylists.map((x) => x.id), extras.map((x) => x.id), extras.length],
    );
    const ok = new Set(rows.map((r) => r.stylist_id));
    stylists = stylists.filter((x) => ok.has(x.id));
    if (!stylists.length) {
      throw new HttpError(404, stylistSlug
        ? 'That stylist does not offer all of these services.'
        : 'No stylist currently offers all of these services together.');
    }
  }
  // How long the visit is depends on who does it: each stylist's own
  // figures for the work, where they have typed them (timing.js), else the
  // services table's. Moving an appointment that already exists keeps its
  // own length and breaks, which for a visit of several services is longer
  // than its first service.
  const visitFor = (stylist) => (length
    ? {
      ...combineServices(service, extras),
      durationMin: length.durationMin,
      bufferMin: length.bufferMin,
      breaks: cleanBreaks(length.breaks, length.durationMin),
    }
    : combineServices(timedService(service, stylist.details), extras.map((x) => timedService(x, stylist.details))));
  const stylistIds = stylists.map((s) => s.id);
  const slugOf = new Map(stylists.map((s) => [s.id, s.slug]));

  const now = DateTime.now().setZone(zone);
  const earliest = now.plus({ minutes: minLeadMin });
  const horizon = now.plus({ days: MAX_ADVANCE_DAYS }).endOf('day');

  let from = DateTime.fromISO(fromDate, { zone }).startOf('day');
  let to = DateTime.fromISO(toDate, { zone }).endOf('day');
  if (!from.isValid || !to.isValid) throw new HttpError(400, 'Those dates are not valid.');
  if (to < from) throw new HttpError(400, 'The end date is before the start date.');

  // Clamp rather than reject: asking for last week is a harmless request that
  // should simply come back with nothing before today.
  if (from < now.startOf('day')) from = now.startOf('day');
  if (to > horizon) to = horizon;
  if (Interval.fromDateTimes(from, to).length('days') > MAX_ADVANCE_DAYS) {
    throw new HttpError(400, 'That date range is too wide.');
  }

  // For guests: a connected stylist's Google busy times are taken out too,
  // and one whose calendar cannot be read right now is offered nothing.
  const gbusy = google
    ? await googleBusyFor(client, stylistIds, from.toISO(), to.toISO(), zone)
    : new Map();
  if (google) {
    // Online, only stylists who have connected a Google Calendar are offered
    // (the salon's rule): googleBusyFor answers for exactly those. Without
    // this, somebody just added to the app was bookable at every hour of
    // their shift while their real diary was invisible to us. The salon's
    // current stylists are the exception until they connect (config.js).
    const optional = googleOptional(tenant);
    stylists = stylists.filter((s) => gbusy.has(s.id) || optional.includes(s.slug));
    if (!stylists.length) {
      throw new HttpError(404, stylistSlug
        ? 'That stylist is not taking online bookings yet. Please call the salon.'
        : 'No stylist is taking online bookings for this yet. Please call the salon.');
    }
  }

  const { shifts, busy, closed } = await loadWindow(
    client, tenant.id, stylists.map((s) => s.id), from, to, excludeAppointmentId,
  );
  const visits = new Map(stylists.map((s) => [s.id, visitFor(s)]));
  // What a caller showing one length shows: the stylist asked for, else the
  // first of those who could take it.
  const visit = visits.get(stylists[0].id);

  const days = [];
  for (let day = from; day <= to; day = day.plus({ days: 1 })) {
    const weekday = weekdayOf(day);
    /** @type {Map<number, string[]>} start instant -> stylist ids free then */
    const found = new Map();

    for (const stylist of stylists) {
      const gb = gbusy.get(stylist.id);
      if (gb === 'unreachable') continue;
      // The hours stored here, which are the Synergy Calendar's.
      const dayShifts = (shifts.get(stylist.id) ?? []).filter((sh) => sh.weekday === weekday);

      const own = visits.get(stylist.id);
      // The time the guest is in the chair, and that plus the turnaround
      // after them.
      const working = workSpans(own);
      const turnaround = [...working, ...cleanDown(own)];
      const blockMin = own.durationMin + (own.bufferMin || 0);
      const clash = (startMs, spans, against) => spans.some(([a, b]) => overlapsAny(
        startMs + a * 60_000, startMs + b * 60_000, against));

      /**
       * Is this stylist free for the visit, starting here?
       *
       * Asked of one thing in their day at a time, because the answer is not
       * the same for all of them. Normally the visit takes its own time and
       * the turnaround after it, so two appointments keep the salon's gap
       * between them and the station can be reset.
       *
       * The exception is a visit that fits entirely inside somebody's
       * processing break. The stylist is borrowed for it and goes straight
       * back to a guest who is still sitting there with colour on: there is
       * no station to turn round between the two, so the break can be filled
       * to the minute, which is the whole point of freeing a stylist while a
       * colour develops. The turnaround still counts against everything else
       * in the day, that same guest's next appointment included.
       */
      const freeFor = (startMs) => {
        const guestEnd = startMs + own.durationMin * 60_000;
        return (busy.get(stylist.id) ?? []).every((entry) => {
          const borrowed = entry.breaks.some(([a, b]) => startMs >= a && guestEnd <= b);
          return !clash(startMs, borrowed ? working : turnaround, entry.spans);
        });
      };

      for (const shift of dayShifts) {
        const [oh, om] = String(shift.starts_at).split(':').map(Number);
        const [ch, cm] = String(shift.ends_at).split(':').map(Number);
        const opens = day.set({ hour: oh, minute: om, second: 0, millisecond: 0 });
        const closes = day.set({ hour: ch, minute: cm, second: 0, millisecond: 0 });
        if (!opens.isValid || !closes.isValid) continue;   // clocks changed over this hour

        for (let start = opens; start <= closes; start = start.plus({ minutes: SLOT_STEP_MIN })) {
          // The guest must be finished by closing. Clean-down may run over,
          // which is how a salon actually works and gives back the last
          // appointment of the day.
          if (start.plus({ minutes: own.durationMin }) > closes) break;
          if (start < earliest) continue;

          const startMs = start.toMillis();
          // A salon closure stops the whole visit, turnaround and all: the
          // guest is in the chair through a processing break too.
          if (overlapsAny(startMs, start.plus({ minutes: blockMin }).toMillis(), closed)) continue;
          // Their own bookings and blocks. A colour's Break is free time,
          // and so is another colour's.
          if (!freeFor(startMs)) continue;
          // Google: the guest's own time must be clear where the stylist is
          // working; the turnaround is ours.
          if (gb && clash(startMs, working, gb)) continue;

          const who = found.get(startMs);
          if (who) who.push(stylist.id);
          else found.set(startMs, [stylist.id]);
        }
      }
    }

    if (found.size) {
      days.push({
        date: day.toISODate(),
        slots: [...found.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([ms, ids]) => ({
            start: DateTime.fromMillis(ms, { zone }).toISO(),
            stylists: ids.map((id) => slugOf.get(id)),
            stylistIds: ids,
          })),
      });
    }
  }

  return { service, extras, visit, visits, stylists, days };
}

/**
 * Pick who takes the appointment when "first available" was chosen.
 *
 * Synergy distributes new guests round-robin, so this spreads work by upcoming
 * load rather than always handing it to whoever sorts first. Ties break on the
 * team's display order, which keeps the result stable and explainable.
 */
export async function chooseStylist(client, candidateIds) {
  if (candidateIds.length === 1) return candidateIds[0];

  const { rows } = await client.query(
    `SELECT s.id,
            COUNT(a.id) FILTER (
              WHERE a.status = 'booked' AND a.starts_at >= now()
                AND a.starts_at < now() + interval '14 days'
            ) AS upcoming
       FROM stylists s
       LEFT JOIN appointments a ON a.stylist_id = s.id
      WHERE s.id = ANY($1)
      GROUP BY s.id, s.sort_order
      ORDER BY upcoming ASC, s.sort_order ASC
      LIMIT 1`,
    [candidateIds],
  );
  return rows[0]?.id ?? candidateIds[0];
}
