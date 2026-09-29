/**
 * GET  /api/staff/calendars — the signed-in user's own calendar link.
 * POST /api/staff/calendars — { action: 'regenerate' }
 *
 * Yours and nobody else's. The first version listed every stylist's link on
 * one page so an owner could hand them out, which meant anybody who opened
 * Settings could read the whole team's diaries from their own phone. A
 * calendar link is a credential; there is no id in this request for the same
 * reason there is none in the profile route.
 *
 * A stylist gets their own appointments. Somebody with no chair -- an owner,
 * the front desk -- gets the whole shop's day, which is what they are trying
 * to see anyway.
 */
import { assertSameOrigin, requireStaff } from '../../_lib/auth.js';
import { query } from '../../_lib/db.js';
import { HttpError, handler, json, readJson, requireString } from '../../_lib/http.js';
import { tenantForUser } from '../../_lib/tenant.js';

function hostOf(req) {
  return String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
}

/**
 * The three links a Connect button needs.
 *
 * Each provider has its own way of being handed a subscription URL, and all
 * three are better than telling somebody to find "add calendar from URL" in a
 * settings menu they have never opened. webcal:// is what makes Apple
 * subscribe rather than download a one-off copy that never updates again.
 */
function connectLinks(req, token) {
  const host = hostOf(req);
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  const url = `${proto}://${host}/calendar/${token}.ics`;
  const webcal = `webcal://${host}/calendar/${token}.ics`;
  return {
    url,
    webcal,
    google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`,
    outlook: 'https://outlook.live.com/calendar/0/addfromweb?url=' + encodeURIComponent(url),
    apple: webcal,
  };
}

async function mine(userId) {
  const { rows } = await query(
    `SELECT u.calendar_token, u.name,
            s.id AS stylist_id, s.name AS stylist_name,
            count(a.id) FILTER (
              WHERE a.status = 'booked' AND a.starts_at >= now()
            )::int AS upcoming
       FROM staff_users u
       LEFT JOIN stylists s ON s.staff_user_id = u.id AND s.active
       LEFT JOIN appointments a
              ON a.tenant_id = u.tenant_id
             AND (s.id IS NULL OR a.stylist_id = s.id)
      WHERE u.id = $1
      GROUP BY u.calendar_token, u.name, s.id, s.name`,
    [userId],
  );
  return rows[0] ?? null;
}

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);
    const row = await mine(user.id);
    if (!row?.calendar_token) throw new HttpError(404, 'No calendar link for this account.');

    return json(res, 200, {
      // What the feed will actually contain, said plainly, because "your
      // calendar" means two different things depending on who is asking.
      scope: row.stylist_id ? 'mine' : 'shop',
      label: row.stylist_id ? row.stylist_name : tenant.name,
      describes: row.stylist_id
        ? 'Your own appointments'
        : `Every appointment at ${tenant.name}`,
      upcoming: row.upcoming,
      ...connectLinks(req, row.calendar_token),
    });
  },

  async POST(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req);
    const body = await readJson(req);
    if (requireString(body.action, 'Action', { max: 20 }) !== 'regenerate') {
      throw new HttpError(400, 'That is not something you can do to a calendar link.');
    }

    const { rows } = await query(
      `UPDATE staff_users
          SET calendar_token = replace(gen_random_uuid()::text, '-', '')
                            || replace(gen_random_uuid()::text, '-', '')
        WHERE id = $1
        RETURNING calendar_token`,
      [user.id],
    );
    if (!rows[0]) throw new HttpError(404, 'That account no longer exists.');

    return json(res, 200, { ...connectLinks(req, rows[0].calendar_token), regenerated: true });
  },
});
