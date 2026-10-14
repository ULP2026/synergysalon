/** GET /api/services — the menu the booking form is built from. */
import { query } from './_lib/db.js';
import { GOOGLE_CONNECTED_SQL } from './_lib/google-busy.js';
import { stylistPhoto } from './_lib/stylist-photos.js';
import { handler, json } from './_lib/http.js';
import { tenantForRequest } from './_lib/tenant.js';

export default handler({
  async GET(req, res) {
    const tenant = await tenantForRequest(req);

    const [services, stylists, offers] = await Promise.all([
      query(
        `SELECT slug, name, category, blurb, duration_min, price_cents, consult_first
           FROM services WHERE tenant_id = $1 AND active ORDER BY sort_order`,
        [tenant.id],
      ),
      query(
        // The photo through to_jsonb, so this still runs before migration 012.
        `SELECT slug, name, title, to_jsonb(stylists) ->> 'photo' AS photo FROM stylists
          WHERE tenant_id = $1 AND active ORDER BY sort_order`,
        [tenant.id],
      ),
      query(
        // Only stylists with a Google Calendar connected: online booking
        // offers nobody else (availability.js), so the survey must not list
        // them either. Pricing and services are untouched; they come back
        // the moment their calendar is connected.
        `SELECT v.slug AS service_slug, s.slug AS stylist_slug
           FROM stylist_services ss
           JOIN stylists s ON s.id = ss.stylist_id AND s.active
           JOIN services v ON v.id = ss.service_id AND v.active
           JOIN staff_users u ON u.id = s.staff_user_id
          WHERE s.tenant_id = $1 AND ${GOOGLE_CONNECTED_SQL}`,
        [tenant.id],
      ),
    ]);

    const by = new Map();
    for (const row of offers.rows) {
      if (!by.has(row.service_slug)) by.set(row.service_slug, []);
      by.get(row.service_slug).push(row.stylist_slug);
    }

    return json(res, 200, {
      salon: { name: tenant.name, timezone: tenant.timezone },
      services: services.rows.map((s) => ({
        slug: s.slug,
        name: s.name,
        category: s.category,
        blurb: s.blurb,
        durationMin: s.duration_min,
        // Null price is meaningful: the salon's menu is being rebuilt, so the
        // front end says "priced at consultation" rather than inventing one.
        price: s.price_cents == null ? null : s.price_cents / 100,
        consultFirst: s.consult_first,
        stylists: by.get(s.slug) ?? [],
      })),
      // Only stylists who offer something and have connected their Google
      // Calendar: the booking survey lists these, and nobody else can be
      // booked online.
      stylists: stylists.rows
        .filter((s) => offers.rows.some((o) => o.stylist_slug === s.slug))
        .map((s) => ({
          slug: s.slug,
          name: s.name,
          title: s.title,
          // The salon's portrait first; an uploaded photo is a data: URL and
          // too heavy to hand to every visitor, so it is left out here.
          photo: stylistPhoto(tenant.slug, s.slug) || (s.photo && !s.photo.startsWith('data:') ? s.photo : null),
        })),
    });
  },
});
