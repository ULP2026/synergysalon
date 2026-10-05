/**
 * GET /api/staff/me: who is signed in, and what the console needs to render.
 *
 * Returns 401 rather than redirecting, so the page can decide whether to show
 * the login form or the diary without a round trip that loses the URL someone
 * was trying to reach.
 */
import { requireStaff } from '../../_lib/auth.js';
import { REMINDER_LEAD_HOURS } from '../../_lib/config.js';
import { query } from '../../_lib/db.js';
import { googleConfigured } from '../../_lib/google.js';
import { handler, json } from '../../_lib/http.js';
import { ensureSchema } from '../../_lib/ensure-schema.js';
import { stylistPhoto } from '../../_lib/stylist-photos.js';
import { tenantForUser } from '../../_lib/tenant.js';

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);
    // Every console session starts here, so this is where the profile
    // columns get made if db:migrate has not been run (see ensure-schema.js).
    await ensureSchema();

    const canAdmin = ['owner', 'manager'].includes(user.role);
    const [services, stylists, pending, own, team] = await Promise.all([
      query(
        `SELECT slug, name, duration_min, price_cents, consult_first
           FROM services WHERE tenant_id = $1 AND active ORDER BY sort_order`,
        [tenant.id],
      ),
      // The photo is the linked login's picture, so a stylist who changes it
      // in the team modal changes it on the day view's column too.
      query(
        // to_jsonb reads stylists.photo without naming it, so this still runs
        // on a database that has not had migration 012 yet.
        `SELECT s.slug, s.name, s.title,
                COALESCE(u.avatar, to_jsonb(s) ->> 'photo') AS photo
           FROM stylists s
           LEFT JOIN staff_users u ON u.id = s.staff_user_id
          WHERE s.tenant_id = $1 AND s.active ORDER BY s.sort_order`,
        [tenant.id],
      ),
      // Drives the badge on Settings, so a request does not sit unseen.
      canAdmin
        ? query("SELECT count(*)::int n FROM staff_users WHERE tenant_id = $1 AND status = 'pending'", [tenant.id])
        : Promise.resolve({ rows: [{ n: 0 }] }),
      // A stylist who never uploaded a picture still has the portrait the
      // public site shows; the chip and the team list use it.
      query(
        `SELECT to_jsonb(s) ->> 'photo' AS photo, s.slug FROM stylists s
          WHERE s.staff_user_id = $1 LIMIT 1`,
        [user.id],
      ),
      // Everyone active, for the Clients filters: stylists by name, or the
      // whole team as stand-ins while nobody has the Stylist role. Names and
      // roles only, which everybody on the team already sees on the diary.
      query(
        `SELECT u.id, u.name, u.role, s.slug AS stylist_slug,
                to_jsonb(u) ->> 'username' AS username
           FROM staff_users u
           LEFT JOIN stylists s ON s.staff_user_id = u.id
          WHERE u.tenant_id = $1 AND u.status = 'active'
          ORDER BY u.name`,
        [tenant.id],
      ),
    ]);

    return json(res, 200, {
      user: {
        name: user.name, email: user.email, role: user.role, canAdmin,
        avatar: user.avatar ?? null,
        photo: own.rows[0]?.photo ?? (own.rows[0] ? stylistPhoto(tenant.slug, own.rows[0].slug) : null),
      },
      pendingApprovals: pending.rows[0].n,
      // The logo is the nav's mark, so it arrives with everything else rather
      // than waiting for Settings to be opened.
      salon: { name: tenant.name, timezone: tenant.timezone, logo: tenant.logo ?? null },
      services: services.rows.map((s) => ({
        slug: s.slug,
        name: s.name,
        durationMin: s.duration_min,
        price: s.price_cents == null ? null : s.price_cents / 100,
        consultFirst: s.consult_first,
      })),
      // A real picture first: an uploaded photo, then the salon's portrait of
      // the stylist, and a chosen avatar only when there is neither.
      stylists: stylists.rows.map((s) => {
        const uploaded = s.photo && s.photo.startsWith('data:') ? s.photo : null;
        const portrait = stylistPhoto(tenant.slug, s.slug);
        return { ...s, photo: uploaded || portrait || s.photo };
      }),
      team: team.rows.map((t) => ({
        id: t.id, name: t.name, role: t.role, stylistSlug: t.stylist_slug,
        // The Clients filters print the username when there is one: short,
        // and what the person chose to be called in the app.
        username: t.username || '',
      })),
      // What Marketing, Automation shows as on or waiting. Whether email can
      // be sent is a fact about this deployment, not a setting anyone edits.
      features: {
        email: Boolean(process.env.RESEND_API_KEY),
        reminderHours: REMINDER_LEAD_HOURS,
        // Connect your tools offers Google only once the site has the
        // credentials to send somebody to Google with.
        google: googleConfigured(),
      },
    });
  },
});
