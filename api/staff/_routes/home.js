/**
 * GET /api/staff/home: the Home page's numbers and its Coming up list.
 *
 * Counted here, in one query each, rather than in the browser from a week of
 * diary days: "clients in the last 30 days" spans more than any page of the
 * diary, and a total the browser adds up from whatever it happened to fetch
 * is a total that is quietly wrong the day it fetches less.
 *
 *   clients30   clients served in the last 30 days: people with a kept
 *               appointment (not cancelled, not a no-show) that has started,
 *               each person once.
 *   newClients30  of those, the ones whose first kept visit was in the
 *               window: new to the salon, not just new to the database.
 *   today       today's appointments on the salon's clock, cancelled left out,
 *               and what they are worth. An appointment's own price first,
 *               then its service's list price; one with neither is counted
 *               and said, never guessed at.
 *   appts30     appointments in the last 30 days that have started,
 *               cancelled left out, for the line under today's figure.
 *   upcoming    the next appointments still to happen, soonest first.
 *   past        how many appointments are behind us, for the footer link.
 *   layout      the dashboard as the admin arranged it (home-layout.js), and
 *   charts      the series its graphics draw, all counted here too:
 *               ahead (next 14 days), visits and value (last 12 weeks),
 *               services, stylists, sources (last 30 days), weekdays (90),
 *               and sourcesBy: sources for the last 7, 30 and 90 days
 *               (week, month, quarter), the card's three ranges.
 *               "Kept" means not cancelled and not a no-show.
 *   newBookings bookings made today, this week and this month on the
 *               salon's clock (when they were booked, not when they are
 *               for), by who made them (website, Karen, front desk) and how
 *               many are a client's first visit; plus the bookings
 *               themselves, newest first. Asked for 2026-11-11, to see
 *               exactly how many new clients booked. Cancelled ones are
 *               counted apart, not in the total.
 *
 * PATCH /api/staff/home { layout }: save the arrangement. The admin only
 * (canManageTeam), because it changes Home for the whole team.
 */
import { DateTime } from 'luxon';

import { assertSameOrigin, canManageTeam, requireStaff } from '../../_lib/auth.js';
import { query } from '../../_lib/db.js';
import { ensureSchema } from '../../_lib/ensure-schema.js';
import {
  DEFAULT_LAYOUT, layoutFrom, layoutOf, WIDGETS, withNewBookings,
} from '../../_lib/home-layout.js';
import {
  HttpError, handler, json, readJson,
} from '../../_lib/http.js';
import { chairIds, chairOf, clientInChairSql } from '../../_lib/scope.js';
import { tenantForUser } from '../../_lib/tenant.js';
import { visitNameSql } from '../../_lib/visit.js';

const UPCOMING = 6;

// Text, not the enum: an appointment_status without the 002 values would
// otherwise fail the whole page over one comparison.
const KEPT = "a.status::text NOT IN ('cancelled', 'no_show')";
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Home counts only the person's own chair unless they are the owner (asked
 * for 2026-11-03, scope.js): $n is the chair's stylist ids, NULL for all.
 */
const OWN = (n) => `AND ($${n}::uuid[] IS NULL OR a.stylist_id = ANY($${n}::uuid[]))`;

/**
 * Who made a booking, as the appointment window says it (bookedLabel in
 * contacts.js): Karen, else the front desk, else the client on the website.
 */
const BOOKED_FROM = `CASE WHEN a.booked_via = 'karen' THEN 'karen'
                          WHEN a.channel::text = 'staff' THEN 'desk' ELSE 'website' END`;

/** First visit, as Coming up counts it: nothing earlier for this guest that was kept. */
const FIRST_VISIT = `(a.contact_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM appointments p
   WHERE p.contact_id = a.contact_id AND p.id <> a.id
     AND p.status <> 'cancelled' AND p.starts_at < a.starts_at))`;

const NEW_BOOKINGS_LIST = 60;

/**
 * Bookings made today, this week (from Monday) and this month, counted
 * exactly in SQL, and the newest of them listed for the card. Periods are
 * on the salon's clock and go by when the booking was made.
 */
export async function newBookings(tenant, now, mine) {
  const since = {
    today: now.startOf('day'),
    week: now.startOf('week'),
    month: now.startOf('month'),
  };
  // The week can start in last month: look back to whichever is earlier.
  const from = since.week < since.month ? since.week : since.month;
  const [counts, rows] = await Promise.all([
    query(
      `WITH b AS (
         SELECT a.created_at, a.status::text = 'cancelled' AS cancelled,
                ${BOOKED_FROM} AS src, ${FIRST_VISIT} AS first
           FROM appointments a
          WHERE a.tenant_id = $1::uuid AND a.created_at >= $2::timestamptz ${OWN(6)})
       SELECT p.k,
              count(*) FILTER (WHERE NOT b.cancelled)::int AS total,
              count(*) FILTER (WHERE NOT b.cancelled AND b.src = 'website')::int AS website,
              count(*) FILTER (WHERE NOT b.cancelled AND b.src = 'karen')::int AS karen,
              count(*) FILTER (WHERE NOT b.cancelled AND b.src = 'desk')::int AS desk,
              count(*) FILTER (WHERE NOT b.cancelled AND b.first)::int AS first,
              count(*) FILTER (WHERE b.cancelled)::int AS cancelled
         FROM (VALUES ('today', $3::timestamptz), ('week', $4::timestamptz), ('month', $5::timestamptz)) AS p(k, since)
         LEFT JOIN b ON b.created_at >= p.since
        GROUP BY p.k`,
      [tenant.id, from.toISO(), since.today.toISO(), since.week.toISO(), since.month.toISO(), mine],
    ),
    query(
      `SELECT a.ref, a.created_at, a.starts_at,
              -- The client's name as it is now (Luis, 2026-11-13: a doubled
              -- last name typed at booking stayed on Home after it was fixed).
              COALESCE(NULLIF(btrim(ct.name), ''), a.guest_name) AS guest_name, s.name AS stylist,
              ${visitNameSql()} AS service, ${BOOKED_FROM} AS src, ${FIRST_VISIT} AS first
         FROM appointments a
         JOIN stylists s ON s.id = a.stylist_id
         JOIN services v ON v.id = a.service_id
         LEFT JOIN contacts ct ON ct.id = a.contact_id
        WHERE a.tenant_id = $1::uuid AND a.created_at >= $2::timestamptz
          AND a.status::text <> 'cancelled' ${OWN(3)}
        ORDER BY a.created_at DESC
        LIMIT ${NEW_BOOKINGS_LIST}`,
      [tenant.id, from.toISO(), mine],
    ),
  ]);

  const zone = tenant.timezone;
  const blank = { total: 0, website: 0, karen: 0, desk: 0, first: 0, cancelled: 0 };
  const by = Object.fromEntries(counts.rows.map((r) => [r.k, {
    total: r.total, website: r.website, karen: r.karen, desk: r.desk, first: r.first, cancelled: r.cancelled,
  }]));
  return {
    counts: { today: by.today || blank, week: by.week || blank, month: by.month || blank },
    items: rows.rows.map((r) => {
      const made = DateTime.fromJSDate(new Date(r.created_at)).setZone(zone);
      const at = DateTime.fromJSDate(new Date(r.starts_at)).setZone(zone);
      return {
        ref: r.ref,
        date: at.toISODate(),
        when: at.toFormat("ccc, LLL d, h:mm a ZZZZ"),
        booked: made.toFormat('LLL d, h:mm a'),
        guestName: r.guest_name,
        service: r.service,
        stylist: r.stylist,
        from: r.src,
        firstVisit: r.first,
        // Which of the card's periods it falls in, so switching needs no new request.
        periods: Object.keys(since).filter((k) => made >= since[k]),
      };
    }),
  };
}

/** Every day or week in the range, with 0 where nothing was counted. */
function fill(rows, keys, label) {
  const by = new Map(rows.map((r) => [r.k, r]));
  return keys.map((k) => ({ key: k, label: label(k), value: Number(by.get(k)?.n ?? 0) }));
}

async function charts(tenant, now, mine = null, userId = null) {
  const zone = tenant.timezone;
  const today = now.startOf('day');
  const ahead14 = today.plus({ days: 14 });
  const week0 = now.startOf('week').minus({ weeks: 11 });
  const since30 = now.minus({ days: 30 });
  const since90 = now.minus({ days: 90 });
  const p = [tenant.id, zone];
  const [ahead, weeks, services, stylists, sources, weekdays, layoutRow] = await Promise.all([
    query(
      `SELECT to_char((a.starts_at AT TIME ZONE $2::text)::date, 'YYYY-MM-DD') AS k, count(*)::int AS n
         FROM appointments a
        WHERE a.tenant_id = $1::uuid AND a.status::text <> 'cancelled'
          AND a.starts_at >= $3::timestamptz AND a.starts_at < $4::timestamptz ${OWN(5)}
        GROUP BY 1`,
      [...p, today.toISO(), ahead14.toISO(), mine],
    ),
    query(
      `SELECT to_char(date_trunc('week', a.starts_at AT TIME ZONE $2::text), 'YYYY-MM-DD') AS k,
              count(*)::int AS n,
              COALESCE(sum(COALESCE(a.price_cents, v.price_cents)), 0)::bigint AS cents,
              count(*) FILTER (WHERE a.price_cents IS NULL AND v.price_cents IS NULL)::int AS unpriced
         FROM appointments a JOIN services v ON v.id = a.service_id
        WHERE a.tenant_id = $1::uuid AND ${KEPT}
          AND a.starts_at >= $3::timestamptz AND a.starts_at <= now() ${OWN(4)}
        GROUP BY 1`,
      [...p, week0.toISO(), mine],
    ),
    query(
      `SELECT v.category AS k, count(*)::int AS n
         FROM appointments a JOIN services v ON v.id = a.service_id
        WHERE a.tenant_id = $1::uuid AND ${KEPT}
          AND a.starts_at >= $2::timestamptz AND a.starts_at <= now() ${OWN(3)}
        GROUP BY 1 ORDER BY 2 DESC`,
      [tenant.id, since30.toISO(), mine],
    ),
    query(
      `SELECT s.name AS k, count(*)::int AS n
         FROM appointments a JOIN stylists s ON s.id = a.stylist_id
        WHERE a.tenant_id = $1::uuid AND ${KEPT}
          AND a.starts_at >= $2::timestamptz AND a.starts_at <= now() ${OWN(3)}
        GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
      [tenant.id, since30.toISO(), mine],
    ),
    // New clients by source for the card's three ranges at once (asked for
    // 2026-11-10: Last week, Last month, Last 3 months), so switching
    // between them on the card needs no second request.
    query(
      `SELECT COALESCE(NULLIF(trim(c.source), ''), 'Not recorded') AS k,
              count(*) FILTER (WHERE c.created_at >= $5::timestamptz)::int AS week,
              count(*) FILTER (WHERE c.created_at >= $2::timestamptz)::int AS month,
              count(*)::int AS quarter
         FROM contacts c
        WHERE c.tenant_id = $1::uuid AND c.created_at >= $6::timestamptz
          AND ${clientInChairSql('c', '$3', '$4')}
        GROUP BY 1`,
      [tenant.id, since30.toISO(), mine, userId, now.minus({ days: 7 }).toISO(), since90.toISO()],
    ),
    query(
      `SELECT extract(dow FROM a.starts_at AT TIME ZONE $2::text)::int AS k, count(*)::int AS n
         FROM appointments a
        WHERE a.tenant_id = $1::uuid AND ${KEPT}
          AND a.starts_at >= $3::timestamptz AND a.starts_at <= now() ${OWN(4)}
        GROUP BY 1`,
      [...p, since90.toISO(), mine],
    ),
    // Through to_jsonb, so Home still loads before migration 019.
    query("SELECT to_jsonb(t) -> 'home_layout' AS layout FROM tenants t WHERE t.id = $1::uuid", [tenant.id]),
  ]);

  const dayKeys = Array.from({ length: 14 }, (_, i) => today.plus({ days: i }).toISODate());
  const weekKeys = Array.from({ length: 12 }, (_, i) => week0.plus({ weeks: i }).toISODate());
  const dayLabel = (k) => DateTime.fromISO(k, { zone }).toFormat('ccc d');
  const weekLabel = (k) => DateTime.fromISO(k, { zone }).toFormat('LLL d');
  const kinds = { cuts: 'Cuts', color: 'Color', treatments: 'Treatments', styling: 'Styling' };
  const list = (rows, name = (k) => k) => rows.map((r) => ({ key: String(r.k), label: name(r.k), value: r.n }));
  const unpriced = weeks.rows.reduce((t, r) => t + r.unpriced, 0);
  // Each range its own top eight, largest first; a source with none in it is left out.
  const byRange = (key) => sources.rows.filter((r) => r[key] > 0).sort((a, b) => b[key] - a[key]).slice(0, 8)
    .map((r) => ({ key: String(r.k), label: r.k, value: r[key] }));
  const sourcesBy = { week: byRange('week'), month: byRange('month'), quarter: byRange('quarter') };

  return {
    layout: withNewBookings(layoutOf(layoutRow.rows[0]?.layout)),
    charts: {
      ahead: fill(ahead.rows, dayKeys, dayLabel),
      visits: fill(weeks.rows, weekKeys, weekLabel),
      value: {
        unit: 'dollars',
        unpriced,
        points: fill(weeks.rows.map((r) => ({ k: r.k, n: Number(r.cents) / 100 })), weekKeys, weekLabel),
      },
      services: list(services.rows, (k) => kinds[k] || String(k).replace(/^./, (c) => c.toUpperCase())),
      stylists: list(stylists.rows),
      // `sources` stays the last 30 days, for anything that reads it as before.
      sources: sourcesBy.month,
      sourcesBy,
      weekdays: fill(weekdays.rows, [1, 2, 3, 4, 5, 6, 0], (k) => DAYS[k]),
    },
  };
}

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);
    const zone = tenant.timezone;
    const now = DateTime.now().setZone(zone);
    const dayFrom = now.startOf('day').toISO();
    const dayTo = now.endOf('day').toISO();
    const since = now.minus({ days: 30 }).toISO();
    const mine = chairIds(await chairOf(user));

    const [clients, today, upcoming, past, dash, appts30, booked] = await Promise.all([
      // Served is a visit that happened. Contacts the website saved for a
      // booking never made used to count here too, which read as clients
      // the salon had not actually seen.
      query(
        `SELECT count(*)::int AS n,
                count(*) FILTER (WHERE NOT EXISTS (
                  SELECT 1 FROM appointments p
                   WHERE p.contact_id = c.contact_id AND p.status::text NOT IN ('cancelled', 'no_show')
                     AND p.starts_at < $2::timestamptz))::int AS fresh
           FROM (SELECT DISTINCT a.contact_id FROM appointments a
                  WHERE a.tenant_id = $1::uuid AND a.contact_id IS NOT NULL AND ${KEPT}
                    AND a.starts_at >= $2::timestamptz AND a.starts_at <= now() ${OWN(3)}) c`,
        [tenant.id, since, mine],
      ),
      query(
        `SELECT count(*)::int AS n,
                COALESCE(sum(COALESCE(a.price_cents, v.price_cents)), 0)::bigint AS cents,
                count(*) FILTER (WHERE a.price_cents IS NULL AND v.price_cents IS NULL)::int AS unpriced
           FROM appointments a
           JOIN services v ON v.id = a.service_id
          WHERE a.tenant_id = $1::uuid AND a.status <> 'cancelled'
            AND a.starts_at >= $2::timestamptz AND a.starts_at <= $3::timestamptz ${OWN(4)}`,
        [tenant.id, dayFrom, dayTo, mine],
      ),
      query(
        `SELECT a.ref, a.starts_at, a.duration_min, a.channel, a.checked_in_at,
                COALESCE(NULLIF(btrim(ct.name), ''), a.guest_name) AS guest_name,
                s.name AS stylist, ${visitNameSql()} AS service,
                COALESCE(a.price_cents, v.price_cents) AS price_cents,
                -- First visit: nothing earlier for this guest that was kept.
                NOT EXISTS (SELECT 1 FROM appointments p
                             WHERE p.contact_id = a.contact_id AND p.id <> a.id
                               AND p.status <> 'cancelled' AND p.starts_at < a.starts_at) AS first_visit
           FROM appointments a
           JOIN stylists s ON s.id = a.stylist_id
           JOIN services v ON v.id = a.service_id
           LEFT JOIN contacts ct ON ct.id = a.contact_id
          WHERE a.tenant_id = $1::uuid AND a.status = 'booked' AND a.starts_at > now() ${OWN(2)}
          ORDER BY a.starts_at
          LIMIT ${UPCOMING}`,
        [tenant.id, mine],
      ),
      query(
        `SELECT count(*)::int AS n FROM appointments a
          WHERE a.tenant_id = $1::uuid AND a.status <> 'cancelled' AND a.starts_at <= now() ${OWN(2)}`,
        [tenant.id, mine],
      ),
      charts(tenant, now, mine, user.id),
      query(
        `SELECT count(*)::int AS n FROM appointments a
          WHERE a.tenant_id = $1::uuid AND a.status::text <> 'cancelled'
            AND a.starts_at >= $2::timestamptz AND a.starts_at <= now() ${OWN(3)}`,
        [tenant.id, since, mine],
      ),
      newBookings(tenant, now, mine),
    ]);

    const t = today.rows[0];
    return json(res, 200, {
      timezone: zone,
      clients30: clients.rows[0].n,
      newClients30: clients.rows[0].fresh,
      appts30: appts30.rows[0].n,
      today: { count: t.n, value: Number(t.cents) / 100, unpriced: t.unpriced },
      upcoming: upcoming.rows.map((r) => {
        const at = DateTime.fromJSDate(new Date(r.starts_at)).setZone(zone);
        return {
          ref: r.ref,
          startsAt: r.starts_at,
          date: at.toISODate(),
          // "Tue, Oct 6, 1:00 PM EDT": the reference's format, on the salon's clock.
          when: at.toFormat("ccc, LLL d, h:mm a ZZZZ"),
          durationMin: r.duration_min,
          guestName: r.guest_name,
          service: r.service,
          stylist: r.stylist,
          price: r.price_cents == null ? null : r.price_cents / 100,
          online: r.channel === 'online',
          firstVisit: r.first_visit,
        };
      }),
      past: past.rows[0].n,
      newBookings: booked,
      layout: dash.layout,
      charts: dash.charts,
      widgets: WIDGETS,
      // For Reset in the editor, which puts this back without saving.
      defaultLayout: DEFAULT_LAYOUT,
      canCustomize: canManageTeam(user),
    });
  },

  async PATCH(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req);
    if (!canManageTeam(user)) throw new HttpError(403, 'Only the salon’s admin can change Home.');
    const tenant = await tenantForUser(user);
    const body = await readJson(req);
    // null puts the default back.
    const layout = body.layout === null ? null : layoutFrom(body.layout);
    await ensureSchema();
    await query('UPDATE tenants SET home_layout = $2::jsonb WHERE id = $1::uuid',
      [tenant.id, layout == null ? null : JSON.stringify(layout)]);
    return json(res, 200, { layout: layoutOf(layout) });
  },
});
