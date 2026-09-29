/**
 * GET  /api/staff/calendars  — every stylist's subscribe link.
 * POST /api/staff/calendars  — { stylistId, action: 'regenerate' }
 *
 * The link is a credential, so it is only ever shown to somebody already
 * signed in to the console. Regenerating breaks whatever devices held the old
 * one, which is exactly what it is for: a stylist who leaves, or a URL
 * forwarded to somebody it should not have been.
 */
import { assertSameOrigin, requireStaff } from '../../_lib/auth.js';
import { query } from '../../_lib/db.js';
import { HttpError, handler, json, readJson, requireString } from '../../_lib/http.js';
import { tenantForUser } from '../../_lib/tenant.js';

/** Same bar as the rest of team management. */
const CAN_MANAGE = ['owner', 'manager'];

function feedUrl(req, token) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  // The .ics on the end is cosmetic and load-bearing at once: some clients
  // refuse to subscribe to a URL that does not look like a calendar file.
  return `${proto}://${host}/calendar/${token}.ics`;
}

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);

    const { rows } = await query(
      `SELECT s.id, s.name, s.title, s.active, s.calendar_token,
              count(a.id) FILTER (
                WHERE a.status = 'booked' AND a.starts_at >= now()
              )::int AS upcoming
         FROM stylists s
         LEFT JOIN appointments a ON a.stylist_id = s.id
        WHERE s.tenant_id = $1
        GROUP BY s.id
        ORDER BY s.active DESC, s.sort_order, s.name`,
      [tenant.id],
    );

    return json(res, 200, {
      stylists: rows.map((r) => ({
        id: r.id,
        name: r.name,
        title: r.title,
        active: r.active,
        upcoming: r.upcoming,
        url: r.calendar_token ? feedUrl(req, r.calendar_token) : null,
      })),
    });
  },

  async POST(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req, CAN_MANAGE);
    const tenant = await tenantForUser(user);
    const body = await readJson(req);

    const id = requireString(body.stylistId, 'Stylist', { max: 64 });
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'Stylist is not valid.');
    if (requireString(body.action, 'Action', { max: 20 }) !== 'regenerate') {
      throw new HttpError(400, 'That is not something you can do to a calendar link.');
    }

    const { rows } = await query(
      `UPDATE stylists
          SET calendar_token = replace(gen_random_uuid()::text, '-', '')
                            || replace(gen_random_uuid()::text, '-', '')
        WHERE id = $1 AND tenant_id = $2
        RETURNING name, calendar_token`,
      [id, tenant.id],
    );
    if (!rows[0]) throw new HttpError(404, 'No such stylist.');

    return json(res, 200, { name: rows[0].name, url: feedUrl(req, rows[0].calendar_token) });
  },
});
