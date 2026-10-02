/**
 * GET /api/availability?service=…&stylist=…&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * `stylist` is optional; leaving it out means "first available" and each slot
 * comes back with the stylists who could take it.
 */
import { availableSlots } from './_lib/availability.js';
import { pool } from './_lib/db.js';
import { handler, json, requireDate, requireId } from './_lib/http.js';
import { tenantForRequest } from './_lib/tenant.js';

export default handler({
  async GET(req, res) {
    const tenant = await tenantForRequest(req);
    const url = new URL(req.url, 'http://localhost');

    const serviceSlug = requireId(url.searchParams.get('service'), 'Service');
    const stylistParam = url.searchParams.get('stylist');
    const stylistSlug = stylistParam && stylistParam !== 'any'
      ? requireId(stylistParam, 'Stylist')
      : null;

    const from = requireDate(url.searchParams.get('from'), 'Start date');
    const to = requireDate(url.searchParams.get('to') || from, 'End date');

    const client = await pool().connect();
    try {
      const { service, stylists, days } = await availableSlots(client, tenant, {
        serviceSlug, stylistSlug, fromDate: from, toDate: to, centro: false,   // our own hours, not a third party's
      });
      return json(res, 200, {
        timezone: tenant.timezone,
        service: {
          slug: service.slug,
          name: service.name,
          durationMin: service.duration_min,
          price: service.price_cents == null ? null : service.price_cents / 100,
          consultFirst: service.consult_first,
        },
        stylists: stylists.map(({ slug, name, title }) => ({ slug, name, title })),
        // stylistIds are internal; the public shape carries slugs only.
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
