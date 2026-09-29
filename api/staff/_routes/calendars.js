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
import { disconnectGoogle, googleConfigured } from '../../_lib/google.js';
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

/**
 * Which calendar service came for the feed, as far as the user agent says.
 *
 * Deliberately a guess rather than a fact. Google identifies itself clearly,
 * Apple's devices less so, and anything unrecognised is reported as
 * "a calendar app" instead of being forced into one of three boxes.
 */
function providerFrom(agent) {
  const a = String(agent || '');
  if (/Google/i.test(a)) return 'google';
  if (/CalendarAgent|Mac OS X|iOS|iPhone|iPad|dataaccessd/i.test(a)) return 'apple';
  if (/Outlook|Microsoft|Office/i.test(a)) return 'outlook';
  return a ? 'other' : null;
}

async function mine(userId) {
  const { rows } = await query(
    `SELECT u.calendar_token, u.name,
            u.calendar_last_fetch, u.calendar_fetches, u.calendar_last_agent,
            u.google_email, u.google_connected_at,
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
      -- Grouped by the primary keys, so every other column of either table
      -- comes along without being listed. Naming them individually is how
      -- this broke: three columns were added to the SELECT and the GROUP BY
      -- was left behind.
      GROUP BY u.id, s.id`,
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
      // "Connected" means a calendar service has actually fetched this feed,
      // not that somebody pressed a button. Nothing else would be true.
      connected: Boolean(row.calendar_last_fetch),
      lastFetch: row.calendar_last_fetch,
      fetches: row.calendar_fetches,
      provider: providerFrom(row.calendar_last_agent),
      // Google is a different kind of connection from the others: it is
      // granted rather than subscribed, so we know for certain whether it is
      // on, and which account it is on.
      google: {
        available: googleConfigured(),
        connected: Boolean(row.google_email || row.google_connected_at),
        account: row.google_email || null,
        since: row.google_connected_at,
      },
      ...connectLinks(req, row.calendar_token),
    });
  },

  async POST(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req);
    const body = await readJson(req);
    const action = requireString(body.action, 'Action', { max: 24 });

    // Revoking Google is its own thing: it does not touch the subscribe link,
    // and the subscribe link's disconnect does not touch Google.
    if (action === 'disconnect-google') {
      await disconnectGoogle(user.id);
      return json(res, 200, { disconnected: 'google' });
    }

    if (action !== 'regenerate') {
      throw new HttpError(400, 'That is not something you can do to a calendar link.');
    }

    const { rows } = await query(
      `UPDATE staff_users
          SET calendar_token = replace(gen_random_uuid()::text, '-', '')
                            || replace(gen_random_uuid()::text, '-', ''),
              -- The old link is dead, so the evidence that something was
              -- subscribed to it is dead with it. Leaving it would show
              -- "Connected" for a URL nothing can reach any more.
              calendar_last_fetch = NULL,
              calendar_fetches = 0,
              calendar_last_agent = NULL
        WHERE id = $1
        RETURNING calendar_token`,
      [user.id],
    );
    if (!rows[0]) throw new HttpError(404, 'That account no longer exists.');

    return json(res, 200, { ...connectLinks(req, rows[0].calendar_token), regenerated: true });
  },
});
