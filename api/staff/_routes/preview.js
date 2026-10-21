/**
 * POST /api/staff/preview: a 12-hour pass to try the public booking popup
 * while online booking is paused (ONLINE_BOOKING in config.js).
 *
 * Owners and managers only. The pass is signed for this salon alone
 * (api/_lib/preview.js); the link it returns opens the public site, where the
 * popup lives, not this console.
 *
 * Moved here from /api/staff/centro {action:'preview'} when the CENTRO link
 * was removed. It never had anything to do with CENTRO; it only lived in that
 * file.
 */
import { assertSameOrigin, requireStaff } from '../../_lib/auth.js';
import { handler, json } from '../../_lib/http.js';
import { mintPreview } from '../../_lib/preview.js';
import { tenantForUser } from '../../_lib/tenant.js';

const ADMIN = ['owner', 'admin', 'manager'];

export default handler({
  async POST(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req, ADMIN);
    const tenant = await tenantForUser(user);
    const host = tenant.host || 'synergysalon.com';
    return json(res, 200, {
      url: `https://${host}/?booking-preview=${encodeURIComponent(mintPreview(tenant.id))}`,
      hours: 12,
    });
  },
});
