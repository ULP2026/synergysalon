/**
 * GET /api/staff/availability?service=&stylist=&date=YYYY-MM-DD[&to=YYYY-MM-DD]
 *
 * With &to, every day from date to to (six weeks at most, what a month view
 * shows), so New appointment's calendar can grey out the days with nothing
 * free. Without it, the one day, as before.
 *
 * The same engine the public page uses, with one difference: no minimum lead
 * time. A guest should not book online for ten minutes' time, but a member of
 * staff looking at the person in front of them should be able to.
 */
import { requireStaff } from '../../_lib/auth.js';
import { availableSlots } from '../../_lib/availability.js';
import { pool } from '../../_lib/db.js';
import { HttpError, handler, json, requireDate, requireId } from '../../_lib/http.js';
import { tenantForUser } from '../../_lib/tenant.js';

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);
    const url = new URL(req.url, 'http://localhost');

    const serviceSlug = requireId(url.searchParams.get('service'), 'Service');
    const stylistParam = url.searchParams.get('stylist');
    const stylistSlug = stylistParam && stylistParam !== 'any'
      ? requireId(stylistParam, 'Stylist')
      : null;
    const date = requireDate(url.searchParams.get('date'), 'Date');
    const to = url.searchParams.get('to') ? requireDate(url.searchParams.get('to'), 'End date') : date;
    const span = (Date.parse(to) - Date.parse(date)) / 86_400_000;
    if (!(span >= 0 && span <= 42)) throw new HttpError(400, 'Ask for six weeks at most, ending after it starts.');

    const client = await pool().connect();
    try {
      const { service, visit, stylists, days } = await availableSlots(client, tenant, {
        serviceSlug, stylistSlug, fromDate: date, toDate: to, minLeadMin: 0,
      });
      return json(res, 200, {
        timezone: tenant.timezone,
        // The visit as the stylist would do it (timing.js), not the table's estimate.
        service: { slug: service.slug, name: service.name, durationMin: visit.durationMin },
        stylists: stylists.map(({ slug, name }) => ({ slug, name })),
        days: days.map((d) => ({
          date: d.date,
          slots: d.slots.map(({ start, stylists: who }) => ({ start, stylists: who })),
        })),
      });
    } finally {
      client.release();
    }
  },
});
