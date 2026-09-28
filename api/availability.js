/**
 * GET /api/availability?service=…&stylist=…&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * `stylist` is optional; leaving it out means "first available" and each slot
 * comes back with the stylists who could take it.
 */
import { availableSlots } from './_lib/availability.js';
import { pool } from './_lib/db.js';
import { handler, json, requireDate, requireId } from './_lib/http.js';

export default handler({
  async GET(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const serviceId = requireId(url.searchParams.get('service'), 'Service');
    const stylistParam = url.searchParams.get('stylist');
    const stylistId = stylistParam && stylistParam !== 'any'
      ? requireId(stylistParam, 'Stylist')
      : null;

    const from = requireDate(url.searchParams.get('from'), 'Start date');
    const to = requireDate(url.searchParams.get('to') || from, 'End date');

    const client = await pool().connect();
    try {
      const { service, stylists, days } = await availableSlots(client, {
        serviceId, stylistId, fromDate: from, toDate: to,
      });
      return json(res, 200, {
        service: {
          id: service.id,
          name: service.name,
          durationMin: service.duration_min,
          price: service.price_cents == null ? null : service.price_cents / 100,
          consultFirst: service.consult_first,
        },
        stylists,
        days,
      });
    } finally {
      client.release();
    }
  },
});
