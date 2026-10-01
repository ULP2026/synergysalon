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
import { handler, json } from '../../_lib/http.js';
import { tenantForUser } from '../../_lib/tenant.js';

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);

    const canAdmin = ['owner', 'manager'].includes(user.role);
    const [services, stylists, pending] = await Promise.all([
      query(
        `SELECT slug, name, duration_min, price_cents, consult_first
           FROM services WHERE tenant_id = $1 AND active ORDER BY sort_order`,
        [tenant.id],
      ),
      // The photo is the linked login's picture, so a stylist who changes it
      // in the team modal changes it on the day view's column too.
      query(
        `SELECT s.slug, s.name, s.title, u.avatar AS photo
           FROM stylists s
           LEFT JOIN staff_users u ON u.id = s.staff_user_id
          WHERE s.tenant_id = $1 AND s.active ORDER BY s.sort_order`,
        [tenant.id],
      ),
      // Drives the badge on Settings, so a request does not sit unseen.
      canAdmin
        ? query("SELECT count(*)::int n FROM staff_users WHERE tenant_id = $1 AND status = 'pending'", [tenant.id])
        : Promise.resolve({ rows: [{ n: 0 }] }),
    ]);

    return json(res, 200, {
      user: {
        name: user.name, email: user.email, role: user.role, canAdmin,
        avatar: user.avatar ?? null,
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
      stylists: stylists.rows,
      // What Marketing, Automation shows as on or waiting. Whether email can
      // be sent is a fact about this deployment, not a setting anyone edits.
      features: {
        email: Boolean(process.env.RESEND_API_KEY),
        reminderHours: REMINDER_LEAD_HOURS,
      },
    });
  },
});
