/** GET /api/services — the menu the booking form is built from. */
import { query } from './_lib/db.js';
import { GOOGLE_CONNECTED_SQL, googleOptional } from './_lib/google-busy.js';
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
        // `uploaded` is a short digest of the picture somebody set in the
        // console, never the picture itself: it is a data: URL on the row and
        // several stylists' worth of base64 would be most of this response,
        // sent to every visitor before they have chosen anything. The digest
        // goes in the /api/photo URL so a new picture is a new URL.
        `SELECT s.slug, s.name, s.title, to_jsonb(s) ->> 'photo' AS photo,
                CASE WHEN u.avatar IS NULL OR u.avatar = '' THEN NULL
                     ELSE left(md5(u.avatar), 8) END AS uploaded
           FROM stylists s
           LEFT JOIN staff_users u ON u.id = s.staff_user_id
          WHERE s.tenant_id = $1 AND s.active ORDER BY s.sort_order`,
        [tenant.id],
      ),
      query(
        // Everyone who offers something, with whether they can be booked
        // online said rather than filtered. The salon wants a stylist on the
        // booking page the moment they are added, even before their calendar
        // is connected: the team is who works here, not who happens to be
        // reachable today. Only the times are withheld.
        //
        // Bookable means a Google Calendar connected, or one of the salon's
        // current stylists (googleOptional) who are let through until they
        // connect. Without a calendar the app cannot see the rest of their
        // day, so offering times would sell the hour of an appointment it
        // does not know about (availability.js).
        `SELECT v.slug AS service_slug, s.slug AS stylist_slug,
                (${GOOGLE_CONNECTED_SQL} OR s.slug = ANY($2::text[])) AS bookable
           FROM stylist_services ss
           JOIN stylists s ON s.id = ss.stylist_id AND s.active
           JOIN services v ON v.id = ss.service_id AND v.active
           LEFT JOIN staff_users u ON u.id = s.staff_user_id
          WHERE s.tenant_id = $1`,
        [tenant.id, googleOptional(tenant)],
      ),
    ]);

    // Per service, only the stylists a guest can actually be given a time
    // with: the slot logic downstream must not be handed anybody else.
    const by = new Map();
    for (const row of offers.rows) {
      if (!row.bookable) continue;
      if (!by.has(row.service_slug)) by.set(row.service_slug, []);
      by.get(row.service_slug).push(row.stylist_slug);
    }

    // Who offers anything at all, and whether any of it is bookable online.
    const bookableBy = new Map();
    for (const row of offers.rows) {
      bookableBy.set(row.stylist_slug, (bookableBy.get(row.stylist_slug) || false) || row.bookable);
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
      // Everyone who offers something, whether or not they can be booked
      // online yet. `bookable` is false until their calendar is connected;
      // the booking survey shows them, offers no times, and says why when
      // one is picked. A stylist nobody can see is indistinguishable from a
      // stylist who has left, and the salon would rather a guest knew who
      // works here and called.
      stylists: stylists.rows
        .filter((s) => bookableBy.has(s.slug))
        .map((s) => ({
          slug: s.slug,
          name: s.name,
          title: s.title,
          bookable: bookableBy.get(s.slug),
          // The salon's own portrait first, because it is a real file and the
          // one the website's team cards use. Then a plain URL on the row.
          // Then whatever they set in the console, served by /api/photo rather
          // than inlined: a data: URL here would be sent to every visitor on
          // every page, where a URL is fetched once, cached for good, and only
          // for the stylists a guest actually looks at. Before this, somebody
          // who set their picture in the app had none on the booking page.
          photo: stylistPhoto(tenant.slug, s.slug)
            || (s.photo && !s.photo.startsWith('data:') ? s.photo : null)
            || (s.uploaded ? `/api/photo?stylist=${encodeURIComponent(s.slug)}&v=${s.uploaded}` : null),
        })),
    });
  },
});
