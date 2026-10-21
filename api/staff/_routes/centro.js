/**
 * /api/staff/centro: the read-only link to CENTRO, and the booking preview.
 *
 *   GET    whether the stored link still reaches CENTRO's calendar
 *   POST   { action: 'link', stylist, ghlUserId } say who a stylist is in CENTRO
 *          { action: 'preview' } a link to try the paused booking popup
 *   GET ?stylists=1   each stylist's CENTRO user and next free time there
 *
 * Owners and managers only. Nothing here sends anything to CENTRO: pushes
 * were switched off on 21 October 2026, and the queue and retry that used to
 * live here went with them.
 */
import { assertSameOrigin, requireStaff } from '../../_lib/auth.js';
import { centroLink, stylistLinks } from '../../_lib/centro-hours.js';
import { pool, query } from '../../_lib/db.js';
import { HttpError, handler, json, readJson } from '../../_lib/http.js';
import { mintPreview } from '../../_lib/preview.js';
import { tenantForUser } from '../../_lib/tenant.js';

const ADMIN = ['owner', 'admin', 'manager'];

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req, ADMIN);
    const tenant = await tenantForUser(user);
    const client = await pool().connect();
    try {
      if (new URL(req.url, 'http://localhost').searchParams.has('stylists')) {
        return json(res, 200, await stylistLinks(client, tenant));
      }
      return json(res, 200, await centroLink(client, tenant.id));
    } finally {
      client.release();
    }
  },

  async POST(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req, ADMIN);
    const tenant = await tenantForUser(user);
    const body = await readJson(req);

    if (body.action === 'link') {
      const slug = String(body.stylist || '');
      const id = body.ghlUserId ? String(body.ghlUserId).trim() : null;
      if (id && !/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw new HttpError(400, 'That is not a CRM user.');
      const { rowCount } = await query(
        'UPDATE stylists SET ghl_user_id = $3 WHERE tenant_id = $1::uuid AND slug = $2',
        [tenant.id, slug, id],
      );
      if (!rowCount) throw new HttpError(404, 'No such stylist.');
      return json(res, 200, { saved: true });
    }

    if (body.action === 'preview') {
      // The public site, not this console: the popup lives there.
      const host = tenant.host || 'synergysalon.com';
      return json(res, 200, {
        url: `https://${host}/?booking-preview=${encodeURIComponent(mintPreview(tenant.id))}`,
        hours: 12,
      });
    }

    throw new HttpError(400, 'Nothing to do.');
  },
});
