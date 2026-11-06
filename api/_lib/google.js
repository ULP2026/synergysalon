/**
 * Google Calendar, per staff member.
 *
 * The subscribe link shows somebody their day in whatever calendar they use.
 * This is the other direction: appointments written as real events into the
 * Google account they actually live in, so the salon's diary appears beside
 * their dentist appointment rather than in a separate subscribed calendar
 * they have to remember to look at.
 *
 * It is also read back: a connected person's events are shown as their own
 * column on Appt. Book, beside the salon's calendar, so the front desk can see
 * when they are busy. Only the times are shown. A stylist's dentist
 * appointment is their business; that they are not free at 2pm is the
 * salon's. The connect card says so before anybody signs in.
 */
import { query } from './db.js';
import { decryptSecret, encryptSecret } from './secrets.js';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';

/**
 * Write access to calendars, plus the address of the account being connected
 * so the console can say which one it is. Nothing else: every extra scope is
 * another thing Google's reviewers ask about and another thing a stylist has
 * to agree to.
 */
export const SALON_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';

export const SCOPES = [
  // openid is what makes Google return an id_token. Without it the callback
  // has no way to say which account was connected without a second API call,
  // and the console shows a connection with no address against it.
  'openid',
  'https://www.googleapis.com/auth/calendar.events',
  // Lets the app create one calendar of its own (named after the salon) and
  // manage only the calendars it created, so bookings sit in their own
  // calendar the stylist can colour, hide or show, apart from their personal
  // events. It grants nothing over calendars the person made themselves.
  SALON_CALENDAR_SCOPE,
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

export function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function redirectUri(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  return `${proto}://${host}/api/oauth/google`;
}

/**
 * Google's own consent screen. `hint` is the address picked in the console's
 * Connect Google Calendar window, so Google opens on that account; with no
 * hint ("Use another account") Google is told to show its account chooser,
 * because a browser signed in to one account otherwise skips straight past it.
 */
export function consentUrl(req, state, { hint } = {}) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: SCOPES,
    // Without these two Google returns no refresh token on a second
    // connection, and the link silently dies an hour later.
    access_type: 'offline',
    prompt: hint ? 'consent' : 'select_account consent',
    include_granted_scopes: 'true',
    state,
  });
  if (hint) p.set('login_hint', hint);
  return `${AUTH}?${p}`;
}

async function tokenCall(body) {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Google refused the token request: ${data.error_description || data.error || res.status}`);
  }
  return data;
}

export function exchangeCode(req, code) {
  return tokenCall({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri(req),
    grant_type: 'authorization_code',
  });
}

/**
 * A usable access token for this user, refreshing it if the stored one has
 * expired. Returns null when they are not connected, or when the refresh
 * token has been revoked from Google's side -- which a person can do at any
 * time, without telling us.
 */
export async function accessTokenFor(userId) {
  const { rows } = await query(
    `SELECT google_refresh_token, google_access_token, google_expires_at
       FROM staff_users WHERE id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row?.google_refresh_token) return null;

  const stillGood = row.google_access_token
    && row.google_expires_at
    // A minute of margin: a token that expires mid-request is a failed push.
    && new Date(row.google_expires_at).getTime() - Date.now() > 60_000;
  if (stillGood) return decryptSecret(row.google_access_token);

  const refresh = decryptSecret(row.google_refresh_token);
  if (!refresh) return null;

  let fresh;
  try {
    fresh = await tokenCall({
      refresh_token: refresh,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    });
  } catch (err) {
    // Revoked, or the app's credentials changed. Clear the connection so the
    // console says "not connected" instead of failing silently forever.
    await disconnectGoogle(userId);
    console.error('google refresh failed; connection cleared', err.message);
    return null;
  }

  await query(
    `UPDATE staff_users
        SET google_access_token = $2,
            google_expires_at = now() + make_interval(secs => $3::int)
      WHERE id = $1`,
    [userId, encryptSecret(fresh.access_token), Number(fresh.expires_in || 3600)],
  );
  return fresh.access_token;
}

// google_calendar_id is kept on disconnect: reconnecting the same account
// finds the salon calendar it already has (salonCalendarFor checks it still
// exists) instead of leaving a second one with the same name beside it.
export async function disconnectGoogle(userId) {
  await query(
    `UPDATE staff_users
        SET google_email = NULL, google_refresh_token = NULL, google_access_token = NULL,
            google_expires_at = NULL, google_connected_at = NULL
      WHERE id = $1`,
    [userId],
  );
  await noteProblem(userId, null);
}


/**
 * What Google's refusal means, when it is one we can explain. A Google
 * account that has never opened Google Calendar (often one made from a
 * work or non-Gmail address) signs in fine, then answers every calendar
 * call with 403 notACalendarUser: there is no calendar to read or write.
 */
export function calendarProblem(err) {
  return /notACalendarUser/.test(String(err?.message || '')) ? 'no_calendar' : null;
}

/** Record (or clear) why this person's Google account cannot be read. */
async function noteProblem(userId, problem) {
  await query(
    'UPDATE staff_users SET google_problem = $2::text WHERE id = $1::uuid AND google_problem IS DISTINCT FROM $2::text',
    [userId, problem],
  ).catch(() => {});
}

/**
 * Whether a fresh token can reach a calendar at all, before the connection
 * is kept. Returns null when it can, else the problem.
 */
export async function checkCalendarAccount(token) {
  try {
    await call(token, `/calendars/primary/events?${new URLSearchParams({ maxResults: '1', timeMin: new Date().toISOString(), fields: 'items(id)' })}`);
    return null;
  } catch (err) {
    return calendarProblem(err) || 'unreadable';
  }
}

async function call(token, path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null;         // the event was deleted in Google
  const text = await res.text();
  if (!res.ok) throw new Error(`Google Calendar ${path} returned ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

/**
 * Put one appointment into a connected calendar, or update the copy already
 * there. The id we stored is what makes the second call an edit rather than a
 * duplicate.
 */
export async function pushEvent(userId, appt, timezone) {
  const token = await accessTokenFor(userId);
  if (!token) return null;

  // Through to_jsonb, so this still runs before migration 020. A copy made
  // before then is in the main calendar, and is edited where it is.
  const { rows } = await query(
    `SELECT event_id, COALESCE(to_jsonb(g) ->> 'calendar_id', 'primary') AS calendar_id
       FROM google_events g WHERE appointment_id = $1 AND staff_user_id = $2`,
    [appt.id, userId],
  );
  const existing = rows[0]?.event_id;
  const existingCal = rows[0]?.calendar_id || 'primary';

  const ends = new Date(new Date(appt.starts_at).getTime() + appt.duration_min * 60_000);
  const body = {
    summary: `${appt.guest_name} · ${appt.service_name}`,
    description: [appt.guest_phone && `Phone: ${appt.guest_phone}`,
      appt.guest_email && `Email: ${appt.guest_email}`,
      appt.notes, `Ref ${appt.ref}`].filter(Boolean).join('\n'),
    start: { dateTime: new Date(appt.starts_at).toISOString(), timeZone: timezone },
    end: { dateTime: ends.toISOString(), timeZone: timezone },
    status: appt.status === 'cancelled' ? 'cancelled' : 'confirmed',
    // The guest is not invited: this is the stylist's own copy of their day,
    // and Google would email everybody involved.
    guestsCanModify: false,
  };

  if (existing) {
    const updated = await call(token, `/calendars/${encodeURIComponent(existingCal)}/events/${existing}`,
                               { method: 'PATCH', body });
    // Gone from Google's side: fall through and create it again.
    if (updated) {
      await query('UPDATE google_events SET updated_at = now() WHERE appointment_id = $1 AND staff_user_id = $2',
                  [appt.id, userId]);
      return existing;
    }
  }

  if (appt.status === 'cancelled') return null;   // nothing to recreate

  const salon = { name: appt.salon_name, timezone };
  let calendarId = await salonCalendarFor(userId, token, salon);
  let created = await call(token, `/calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', body });
  if (!created && calendarId !== 'primary') {
    // The calendar the app used to make was deleted in Google before the
    // merge reached it: the booking goes to their main calendar instead.
    await query('UPDATE staff_users SET google_calendar_id = NULL WHERE id = $1', [userId]);
    calendarId = await salonCalendarFor(userId, token, salon);
    created = await call(token, `/calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', body });
  }
  if (!created) throw new Error(`Google Calendar would not take the event for ${appt.ref}`);
  await query(
    `INSERT INTO google_events (appointment_id, staff_user_id, event_id, calendar_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (appointment_id, staff_user_id)
     DO UPDATE SET event_id = EXCLUDED.event_id, calendar_id = EXCLUDED.calendar_id, updated_at = now()`,
    [appt.id, userId, created.id, calendarId],
  );
  return created.id;
}

/**
 * Copy a lunch or block into the stylist's salon calendar in Google (asked
 * for 2026-10-31), so the time the app has stopped selling shows as taken
 * on their phone too. Shown busy, titled by what it is, with nobody
 * invited. It goes in their main calendar with the bookings (2026-11-06);
 * busyBetween skips it by id, so it is never read back as a second block.
 */
export async function pushBlock(userId, block, timezone, salonName) {
  const token = await accessTokenFor(userId);
  if (!token) return null;
  const calendarId = await salonCalendarFor(userId, token, { name: salonName, timezone });
  const created = await call(token, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    body: {
      summary: block.reason === 'Lunch' ? 'Lunch' : `Blocked · ${block.reason}`,
      description: 'Blocked in the salon app: no bookings at this time.',
      start: { dateTime: new Date(block.startsAt).toISOString(), timeZone: timezone },
      end: { dateTime: new Date(block.endsAt).toISOString(), timeZone: timezone },
      transparency: 'opaque',
    },
  });
  if (!created) throw new Error('Google Calendar would not take the block');
  try {
    await query(
      `INSERT INTO google_blocks (time_off_id, staff_user_id, event_id, calendar_id)
       VALUES ($1::int, $2::uuid, $3, $4)
       ON CONFLICT (time_off_id, staff_user_id)
       DO UPDATE SET event_id = EXCLUDED.event_id, calendar_id = EXCLUDED.calendar_id`,
      [block.id, userId, created.id, calendarId],
    );
  } catch (err) {
    // The block was removed while Google was making its copy: take the copy
    // back out rather than leave it in their calendar with nothing behind it.
    await call(token, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(created.id)}`,
               { method: 'DELETE' }).catch(() => {});
    throw err;
  }
  return created.id;
}

/** Take a block's copy out of Google again; one already gone there is fine. */
export async function dropBlock(userId, eventId, calendarId) {
  const token = await accessTokenFor(userId);
  if (!token) return;
  try {
    await call(token, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
  } catch (err) {
    // 410: deleted in Google already, which is the outcome wanted.
    if (!/ 410:/.test(err.message)) throw err;
  }
}

/**
 * The calendar bookings are written to in this person's Google account:
 * their main calendar, since 2026-11-06 (asked for: "merge the app and
 * website calendar so Dina sees only one calendar in Google"). From
 * 2026-10-14 until then the app made a calendar of the salon's own beside
 * it, which showed as a second "Synergy Salon" in an account that is itself
 * called Synergy Salon. Copies in the main calendar are never read back as
 * busy time (busyBetween skips them by id), so writing there is safe.
 *
 * google_calendar_id is 'primary' for everyone now. One that still holds a
 * calendar the app made is moved over by mergeIntoMain (run by the daily
 * sync) before anything else is written. `verify` is kept for callers and
 * no longer changes anything.
 */
export async function salonCalendarFor(userId, token, salon, { verify = false } = {}) {
  void token; void salon; void verify;
  const { rows } = await query('SELECT google_calendar_id FROM staff_users WHERE id = $1', [userId]);
  const stored = rows[0]?.google_calendar_id;
  if (stored && stored !== 'primary') {
    // Not merged yet: keep writing where the copies are until the sync
    // moves them all at once, so no booking is split across two calendars.
    return stored;
  }
  if (stored !== 'primary') await query("UPDATE staff_users SET google_calendar_id = 'primary' WHERE id = $1", [userId]);
  return 'primary';
}

/**
 * Move one person's salon copies out of the calendar the app made and into
 * their main calendar, and remove that calendar (the app may delete only
 * calendars it made). Bookings are put back by the mirror, which copies
 * every booking with no copy on record; lunches and blocks are put back
 * here. Returns how many copies were moved, or null when there was nothing
 * to merge.
 */
export async function mergeIntoMain(userId) {
  const { rows: [u] } = await query(
    `SELECT u.google_calendar_id AS cal, t.name AS salon, t.timezone
       FROM staff_users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`,
    [userId],
  );
  if (!u?.cal || u.cal === 'primary') return null;
  const token = await accessTokenFor(userId);
  if (!token) return null;
  const { rows: events } = await query(
    'SELECT event_id FROM google_events WHERE staff_user_id = $1 AND calendar_id = $2', [userId, u.cal]);
  const { rows: blocks } = await query(
    `SELECT b.event_id, o.id, o.reason, lower(o.during) AS starts_at, upper(o.during) AS ends_at
       FROM google_blocks b JOIN time_off o ON o.id = b.time_off_id
      WHERE b.staff_user_id = $1 AND b.calendar_id = $2`, [userId, u.cal]).catch(() => ({ rows: [] }));
  try {
    // One call removes the calendar and every copy in it.
    await call(token, `/calendars/${encodeURIComponent(u.cal)}`, { method: 'DELETE' });
  } catch (err) {
    // Could not remove the calendar: take the copies out one by one, so
    // nothing is left twice once they are made again in the main one.
    console.error('merge: salon calendar not removed, removing its copies', err.message);
    for (const e of [...events, ...blocks]) {
      await call(token, `/calendars/${encodeURIComponent(u.cal)}/events/${encodeURIComponent(e.event_id)}`,
        { method: 'DELETE' }).catch(() => {});
    }
  }
  await query('DELETE FROM google_events WHERE staff_user_id = $1 AND calendar_id = $2', [userId, u.cal]);
  await query('DELETE FROM google_blocks WHERE staff_user_id = $1 AND calendar_id = $2', [userId, u.cal]).catch(() => {});
  await query("UPDATE staff_users SET google_calendar_id = 'primary' WHERE id = $1", [userId]);
  for (const b of blocks) {
    if (new Date(b.ends_at) <= new Date()) continue;
    await pushBlock(userId, { id: b.id, reason: b.reason, startsAt: b.starts_at, endsAt: b.ends_at }, u.timezone, u.salon)
      .catch((err) => console.error('merge: block copy not remade', err.message));
  }
  return events.length + blocks.length;
}

/**
 * One person's Google events between two instants, as busy spans.
 *
 * Attendees and descriptions are never asked for (the fields mask leaves
 * them out), so they never pass through this server at all. The event's
 * title is asked for only with `titles` (Appt. Book's day, for the person
 * themselves and the admin, asked for 2026-10-31), and an event marked
 * Private in Google keeps it to itself: it is still just "Busy". Online
 * availability and the team window never ask. Free time marked "show me as
 * available" is skipped: it is in the calendar but it is not a reason to
 * say they are busy. Returns null when the person is not connected.
 */
export async function busyBetween(userId, fromIso, toIso, { titles = false } = {}) {
  const token = await accessTokenFor(userId);
  if (!token) return null;
  const p = new URLSearchParams({
    timeMin: fromIso,
    timeMax: toIso,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
    fields: titles ? 'items(id,status,transparency,start,end,summary,visibility)' : 'items(id,status,transparency,start,end)',
  });
  let data;
  try {
    data = await call(token, `/calendars/primary/events?${p}`);
  } catch (err) {
    const problem = calendarProblem(err);
    if (problem) await noteProblem(userId, problem);
    throw err;
  }
  await noteProblem(userId, null);
  // Copies of salon bookings written to the main calendar (before the salon
  // had its own, or where it could not) are the diary itself, already
  // counted from this database. Read back as Google busy time they blocked a
  // guest from moving their own appointment, so they are left out. The salon
  // calendar is never read at all.
  const { rows: ours } = await query(
    `SELECT event_id FROM google_events g
      WHERE staff_user_id = $1 AND COALESCE(to_jsonb(g) ->> 'calendar_id', 'primary') = 'primary'`,
    [userId],
  ).catch(() => ({ rows: [] }));
  // And the copies of lunches and blocks, which are in the main calendar too
  // since 2026-11-06: the block itself already stops the time.
  const { rows: ourBlocks } = await query(
    "SELECT event_id FROM google_blocks WHERE staff_user_id = $1 AND calendar_id = 'primary'", [userId],
  ).catch(() => ({ rows: [] }));
  const own = new Set([...ours, ...ourBlocks].map((r) => r.event_id));
  return (data?.items || [])
    .filter((e) => e.status !== 'cancelled' && e.transparency !== 'transparent' && !own.has(e.id))
    .map((e) => ({
      // An all-day event has a date and no time: it covers the whole day.
      allDay: Boolean(e.start?.date && !e.start?.dateTime),
      startsAt: e.start?.dateTime || e.start?.date,
      endsAt: e.end?.dateTime || e.end?.date,
      ...(titles ? { title: e.visibility === 'private' || e.visibility === 'confidential' ? null : (e.summary || null) } : {}),
    }));
}
