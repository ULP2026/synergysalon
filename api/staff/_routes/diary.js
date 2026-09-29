/**
 * GET /api/staff/diary?date=YYYY-MM-DD — one day's book, by stylist.
 * GET /api/staff/diary?month=YYYY-MM    — the same rows for a whole month.
 *
 * One query serves both because the month view is the day view zoomed out:
 * the same appointments, grouped by date. A second endpoint would be a second
 * place for the two to disagree about what "cancelled" looks like.
 *
 * Scoped to the signed-in user's salon, never to a tenant named in the query
 * string. Cancelled appointments are included but marked, because the front
 * desk needs to see that the 2pm was cancelled rather than wonder where it
 * went.
 */
import { DateTime } from 'luxon';

import { requireStaff } from '../../_lib/auth.js';
import { query } from '../../_lib/db.js';
import { HttpError, handler, json, requireDate } from '../../_lib/http.js';
import { tenantForUser } from '../../_lib/tenant.js';

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);

    const url = new URL(req.url, 'http://localhost');
    const date = url.searchParams.get('date')
      ? requireDate(url.searchParams.get('date'), 'Date')
      : DateTime.now().setZone(tenant.timezone).toISODate();

    // A month is asked for as YYYY-MM. Anything else is treated as a day, so
    // an unparseable month cannot quietly widen the query to a whole year.
    const monthParam = url.searchParams.get('month');
    const month = /^\d{4}-\d{2}$/.test(monthParam || '')
      ? DateTime.fromISO(`${monthParam}-01`, { zone: tenant.timezone })
      : null;
    if (monthParam && (!month || !month.isValid)) {
      throw new HttpError(400, 'Month must look like 2026-09.');
    }

    const day = DateTime.fromISO(date, { zone: tenant.timezone });
    const from = month ? month.startOf('month') : day.startOf('day');
    const to = month ? month.endOf('month') : day.endOf('day');

    const { rows } = await query(
      `SELECT a.ref, a.starts_at, a.duration_min, a.status, a.channel, a.checked_in_at,
              a.guest_name, a.guest_email, a.guest_phone, a.notes,
              a.price_cents, a.ghl_appointment_id,
              s.slug AS stylist_slug, s.name AS stylist_name,
              v.name AS service_name,
              b.name AS booked_by_name,
              ct.id AS contact_id
         FROM appointments a
         JOIN stylists s ON s.id = a.stylist_id
         JOIN services v ON v.id = a.service_id
         LEFT JOIN staff_users b ON b.id = a.booked_by
         LEFT JOIN contacts ct ON ct.id = a.contact_id
        WHERE a.tenant_id = $1 AND a.starts_at >= $2 AND a.starts_at <= $3
        ORDER BY a.starts_at, s.sort_order`,
      [tenant.id, from.toISO(), to.toISO()],
    );

    const appointments = rows.map((r) => {
      const starts = DateTime.fromJSDate(new Date(r.starts_at)).setZone(tenant.timezone);
      return {
        ref: r.ref,
        startsAt: r.starts_at,
        // The date on the salon's clock, so the month grid puts a late
        // appointment in the right cell regardless of the viewer's timezone.
        date: starts.toISODate(),
        time: starts.toFormat('h:mm a'),
        endTime: starts.plus({ minutes: r.duration_min }).toFormat('h:mm a'),
        durationMin: r.duration_min,
        status: r.status,
        channel: r.channel,
        checkedInAt: r.checked_in_at,
        service: r.service_name,
        stylist: r.stylist_name,
        stylistSlug: r.stylist_slug,
        guestName: r.guest_name,
        guestEmail: r.guest_email,
        guestPhone: r.guest_phone,
        notes: r.notes,
        price: r.price_cents == null ? null : r.price_cents / 100,
        bookedBy: r.booked_by_name,
        contactId: r.contact_id,
        // Lets the console show which bookings have not reached CENTRO yet,
        // rather than the team discovering it from an empty CRM.
        syncedToCentro: Boolean(r.ghl_appointment_id),
      };
    });

    return json(res, 200, {
      date,
      month: month ? month.toFormat('yyyy-MM') : null,
      timezone: tenant.timezone,
      today: DateTime.now().setZone(tenant.timezone).toISODate(),
      heading: month
        ? month.toFormat('LLLL yyyy')
        : day.toFormat('cccc d LLLL yyyy'),
      booked: appointments.filter((a) => a.status !== 'cancelled').length,
      arriving: appointments.filter((a) => a.status === 'booked' && !a.checkedInAt).length,
      appointments,
    });
  },
});
