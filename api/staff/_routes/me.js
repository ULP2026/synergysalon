/**
 * GET /api/staff/me — who is signed in, and what the console needs to render.
 *
 * Returns 401 rather than redirecting, so the page can decide whether to show
 * the login form or the diary without a round trip that loses the URL someone
 * was trying to reach.
 */
import { requireStaff } from '../../_lib/auth.js';
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
      query(
        `SELECT slug, name, title FROM stylists
          WHERE tenant_id = $1 AND active ORDER BY sort_order`,
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
      salon: { name: tenant.name, timezone: tenant.timezone },
      services: services.rows.map((s) => ({
        slug: s.slug,
        name: s.name,
        durationMin: s.duration_min,
        price: s.price_cents == null ? null : s.price_cents / 100,
        consultFirst: s.consult_first,
      })),
      stylists: stylists.rows,
    });
  },
});
