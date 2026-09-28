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
import { HttpError } from './http.js';

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
 * Stylists who are active, offer this service, and (if someone specific was
 * asked for) are that person.
 */
async function loadStylists(client, tenantId, serviceId, stylistSlug) {
  const { rows } = await client.query(
    `SELECT s.id, s.slug, s.name, s.title, s.sort_order
       FROM stylists s
       JOIN stylist_services ss ON ss.stylist_id = s.id
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
    client.query(
      `SELECT stylist_id, lower(during) AS from_ts, upper(during) AS to_ts
         FROM appointments
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

  for (const row of booked.rows) busy.get(row.stylist_id)?.push([+row.from_ts, +row.to_ts]);
  for (const row of off.rows) {
    const span = [+row.from_ts, +row.to_ts];
    if (row.stylist_id === null) closed.push(span);
    else busy.get(row.stylist_id)?.push(span);
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
 */
export async function availableSlots(client, tenant, {
  serviceSlug, stylistSlug, fromDate, toDate,
  excludeAppointmentId = null, minLeadMin = MIN_LEAD_MIN,
}) {
  const zone = tenant.timezone;
  const service = await loadService(client, tenant.id, serviceSlug);
  const stylists = await loadStylists(client, tenant.id, service.id, stylistSlug);
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

  const { shifts, busy, closed } = await loadWindow(
    client, tenant.id, stylistIds, from, to, excludeAppointmentId,
  );
  const blockMin = service.duration_min + service.buffer_min;

  const days = [];
  for (let day = from; day <= to; day = day.plus({ days: 1 })) {
    const weekday = weekdayOf(day);
    /** @type {Map<number, string[]>} start instant -> stylist ids free then */
    const found = new Map();

    for (const stylist of stylists) {
      for (const shift of shifts.get(stylist.id) ?? []) {
        if (shift.weekday !== weekday) continue;

        const [oh, om] = String(shift.starts_at).split(':').map(Number);
        const [ch, cm] = String(shift.ends_at).split(':').map(Number);
        const opens = day.set({ hour: oh, minute: om, second: 0, millisecond: 0 });
        const closes = day.set({ hour: ch, minute: cm, second: 0, millisecond: 0 });
        if (!opens.isValid || !closes.isValid) continue;   // clocks changed over this hour

        for (let start = opens; start <= closes; start = start.plus({ minutes: SLOT_STEP_MIN })) {
          // The guest must be finished by closing. Clean-down may run over,
          // which is how a salon actually works and gives back the last
          // appointment of the day.
          if (start.plus({ minutes: service.duration_min }) > closes) break;
          if (start < earliest) continue;

          const startMs = start.toMillis();
          const blockEndMs = start.plus({ minutes: blockMin }).toMillis();
          if (overlapsAny(startMs, blockEndMs, closed)) continue;
          if (overlapsAny(startMs, blockEndMs, busy.get(stylist.id) ?? [])) continue;

          const free = found.get(startMs);
          if (free) free.push(stylist.id);
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

  return { service, stylists, days };
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
