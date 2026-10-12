/**
 * GET /api/staff/home: the Home page's numbers and its Coming up list.
 *
 * Counted here, in one query each, rather than in the browser from a week of
 * diary days: "clients in the last 30 days" spans more than any page of the
 * diary, and a total the browser adds up from whatever it happened to fetch
 * is a total that is quietly wrong the day it fetches less.
 *
 *   clients30   everyone the salon dealt with in the last 30 days: added to
 *               Clients, or booked in for a visit that has started. One person
 *               who did both is one client.
 *   today       today's appointments on the salon's clock, cancelled left out,
 *               and what they are worth. An appointment's own price first,
 *               then its service's list price; one with neither is counted
 *               and said, never guessed at.
 *   upcoming    the next appointments still to happen, soonest first.
 *   past        how many appointments are behind us, for the footer link.
 *   layout      the dashboard as the admin arranged it (home-layout.js), and
 *   charts      the series its graphics draw, all counted here too:
 *               ahead (next 14 days), visits and value (last 12 weeks),
 *               services, stylists, sources (last 30 days), weekdays (90).
 *               "Kept" means not cancelled and not a no-show.
 *
 * PATCH /api/staff/home { layout }: save the arrangement. The admin only
 * (canManageTeam), because it changes Home for the whole team.
 */
import { DateTime } from 'luxon';

import { assertSameOrigin, canManageTeam, requireStaff } from '../../_lib/auth.js';
import { query } from '../../_lib/db.js';
import { ensureSchema } from '../../_lib/ensure-schema.js';
import {
  DEFAULT_LAYOUT, layoutFrom, layoutOf, WIDGETS,
} from '../../_lib/home-layout.js';
import {
  HttpError, handler, json, readJson,
} from '../../_lib/http.js';
import { tenantForUser } from '../../_lib/tenant.js';

const UPCOMING = 6;

// Text, not the enum: an appointment_status without the 002 values would
// otherwise fail the whole page over one comparison.
const KEPT = "a.status::text NOT IN ('cancelled', 'no_show')";
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Every day or week in the range, with 0 where nothing was counted. */
function fill(rows, keys, label) {
  const by = new Map(rows.map((r) => [r.k, r]));
  return keys.map((k) => ({ key: k, label: label(k), value: Number(by.get(k)?.n ?? 0) }));
}

async function charts(tenant, now) {
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
          AND a.starts_at >= $3::timestamptz AND a.starts_at < $4::timestamptz
        GROUP BY 1`,
      [...p, today.toISO(), ahead14.toISO()],
    ),
    query(
      `SELECT to_char(date_trunc('week', a.starts_at AT TIME ZONE $2::text), 'YYYY-MM-DD') AS k,
              count(*)::int AS n,
              COALESCE(sum(COALESCE(a.price_cents, v.price_cents)), 0)::bigint AS cents,
              count(*) FILTER (WHERE a.price_cents IS NULL AND v.price_cents IS NULL)::int AS unpriced
         FROM appointments a JOIN services v ON v.id = a.service_id
        WHERE a.tenant_id = $1::uuid AND ${KEPT}
          AND a.starts_at >= $3::timestamptz AND a.starts_at <= now()
        GROUP BY 1`,
      [...p, week0.toISO()],
    ),
    query(
      `SELECT v.category AS k, count(*)::int AS n
         FROM appointments a JOIN services v ON v.id = a.service_id
        WHERE a.tenant_id = $1::uuid AND ${KEPT}
          AND a.starts_at >= $2::timestamptz AND a.starts_at <= now()
        GROUP BY 1 ORDER BY 2 DESC`,
      [tenant.id, since30.toISO()],
    ),
    query(
      `SELECT s.name AS k, count(*)::int AS n
         FROM appointments a JOIN stylists s ON s.id = a.stylist_id
        WHERE a.tenant_id = $1::uuid AND ${KEPT}
          AND a.starts_at >= $2::timestamptz AND a.starts_at <= now()
        GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
      [tenant.id, since30.toISO()],
    ),
    query(
      `SELECT COALESCE(NULLIF(trim(c.source), ''), 'Not recorded') AS k, count(*)::int AS n
         FROM contacts c
        WHERE c.tenant_id = $1::uuid AND c.created_at >= $2::timestamptz
        GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
      [tenant.id, since30.toISO()],
    ),
    query(
      `SELECT extract(dow FROM a.starts_at AT TIME ZONE $2::text)::int AS k, count(*)::int AS n
         FROM appointments a
        WHERE a.tenant_id = $1::uuid AND ${KEPT}
          AND a.starts_at >= $3::timestamptz AND a.starts_at <= now()
        GROUP BY 1`,
      [...p, since90.toISO()],
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

  return {
    layout: layoutOf(layoutRow.rows[0]?.layout),
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
      sources: list(sources.rows),
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

    const [clients, today, upcoming, past, dash] = await Promise.all([
      query(
        `SELECT count(*)::int AS n FROM contacts c
          WHERE c.tenant_id = $1::uuid
            AND (c.created_at >= $2::timestamptz
                 OR EXISTS (SELECT 1 FROM appointments a
                             WHERE a.contact_id = c.id AND a.status <> 'cancelled'
                               AND a.starts_at >= $2::timestamptz AND a.starts_at <= now()))`,
        [tenant.id, since],
      ),
      query(
        `SELECT count(*)::int AS n,
                COALESCE(sum(COALESCE(a.price_cents, v.price_cents)), 0)::bigint AS cents,
                count(*) FILTER (WHERE a.price_cents IS NULL AND v.price_cents IS NULL)::int AS unpriced
           FROM appointments a
           JOIN services v ON v.id = a.service_id
          WHERE a.tenant_id = $1::uuid AND a.status <> 'cancelled'
            AND a.starts_at >= $2::timestamptz AND a.starts_at <= $3::timestamptz`,
        [tenant.id, dayFrom, dayTo],
      ),
      query(
        `SELECT a.ref, a.starts_at, a.duration_min, a.channel, a.checked_in_at,
                a.guest_name, s.name AS stylist, v.name AS service,
                COALESCE(a.price_cents, v.price_cents) AS price_cents,
                -- First visit: nothing earlier for this guest that was kept.
                NOT EXISTS (SELECT 1 FROM appointments p
                             WHERE p.contact_id = a.contact_id AND p.id <> a.id
                               AND p.status <> 'cancelled' AND p.starts_at < a.starts_at) AS first_visit
           FROM appointments a
           JOIN stylists s ON s.id = a.stylist_id
           JOIN services v ON v.id = a.service_id
          WHERE a.tenant_id = $1::uuid AND a.status = 'booked' AND a.starts_at > now()
          ORDER BY a.starts_at
          LIMIT ${UPCOMING}`,
        [tenant.id],
      ),
      query(
        `SELECT count(*)::int AS n FROM appointments
          WHERE tenant_id = $1::uuid AND status <> 'cancelled' AND starts_at <= now()`,
        [tenant.id],
      ),
      charts(tenant, now),
    ]);

    const t = today.rows[0];
    return json(res, 200, {
      timezone: zone,
      clients30: clients.rows[0].n,
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
