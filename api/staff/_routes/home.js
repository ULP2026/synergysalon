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
 */
import { DateTime } from 'luxon';

import { requireStaff } from '../../_lib/auth.js';
import { query } from '../../_lib/db.js';
import { handler, json } from '../../_lib/http.js';
import { tenantForUser } from '../../_lib/tenant.js';

const UPCOMING = 6;

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);
    const zone = tenant.timezone;
    const now = DateTime.now().setZone(zone);
    const dayFrom = now.startOf('day').toISO();
    const dayTo = now.endOf('day').toISO();
    const since = now.minus({ days: 30 }).toISO();

    const [clients, today, upcoming, past] = await Promise.all([
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
    });
  },
});
