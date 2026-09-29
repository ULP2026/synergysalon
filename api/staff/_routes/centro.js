/**
 * /api/staff/centro: is the diary reaching CENTRO?
 *
 *   GET    the link, what is queued, and anything CENTRO refused
 *   POST   { action: 'retry' } put refused jobs back in the queue and send
 *          { action: 'link', stylist, ghlUserId } say who a stylist is in CENTRO
 *          { action: 'preview' } a link to try the paused booking popup
 *   GET ?stylists=1   each stylist's CENTRO user and next free time there
 *
 * Owners and managers only. Before this existed, a booking CENTRO refused
 * looked exactly like one still on its way, and five sat failed unnoticed.
 */
import { assertSameOrigin, requireStaff } from '../../_lib/auth.js';
import { stylistLinks } from '../../_lib/centro-hours.js';
import { pool, query } from '../../_lib/db.js';
import { HttpError, handler, json, readJson } from '../../_lib/http.js';
import { mintPreview } from '../../_lib/preview.js';
import { tenantForUser } from '../../_lib/tenant.js';
import { centroStatus } from '../../cron/sync.js';

const ADMIN = ['owner', 'manager'];

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req, ADMIN);
    const tenant = await tenantForUser(user);
    if (new URL(req.url, 'http://localhost').searchParams.has('stylists')) {
      const client = await pool().connect();
      try {
        return json(res, 200, await stylistLinks(client, tenant));
      } finally {
        client.release();
      }
    }
    return json(res, 200, await centroStatus(tenant.id));
  },

  async POST(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req, ADMIN);
    const tenant = await tenantForUser(user);
    const body = await readJson(req);

    if (body.action === 'link') {
      const slug = String(body.stylist || '');
      const id = body.ghlUserId ? String(body.ghlUserId).trim() : null;
      if (id && !/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw new HttpError(400, 'That is not a CENTRO user.');
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

    if (body.action !== 'retry') throw new HttpError(400, 'Nothing to do.');
    return json(res, 200, await centroStatus(tenant.id, { retry: true }));
  },
});
