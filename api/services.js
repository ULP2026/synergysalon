/** GET /api/services — the menu the booking form is built from. */
import { query } from './_lib/db.js';
import { handler, json } from './_lib/http.js';

export default handler({
  async GET(req, res) {
    const [services, stylists, offers] = await Promise.all([
      query(`SELECT id, name, category, blurb, duration_min, price_cents, consult_first
               FROM services WHERE active ORDER BY sort_order`),
      query(`SELECT id, name, title FROM stylists WHERE active ORDER BY sort_order`),
      query(`SELECT ss.service_id, ss.stylist_id
               FROM stylist_services ss
               JOIN stylists s ON s.id = ss.stylist_id AND s.active`),
    ]);

    const by = new Map();
    for (const row of offers.rows) {
      if (!by.has(row.service_id)) by.set(row.service_id, []);
      by.get(row.service_id).push(row.stylist_id);
    }

    return json(res, 200, {
      services: services.rows.map((s) => ({
        ...s,
        // Null price is meaningful: the salon's menu is being rebuilt and the
        // front end says "priced at consultation" rather than inventing one.
        price: s.price_cents == null ? null : s.price_cents / 100,
        stylists: by.get(s.id) ?? [],
      })),
      stylists: stylists.rows,
    });
  },
});
