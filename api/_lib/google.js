/**
 * Google Calendar, per staff member.
 *
 * The subscribe link shows somebody their day in whatever calendar they use.
 * This is the other direction: appointments written as real events into the
 * Google account they actually live in, so the salon's diary appears beside
 * their dentist appointment rather than in a separate subscribed calendar
 * they have to remember to look at.
 *
 * Only the write direction is implemented. Reading a staff member's personal
 * events to block salon slots is a bigger privacy conversation than a checkbox
 * should decide, and is deliberately not done here.
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
export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
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

export function consentUrl(req, state) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: SCOPES,
    // Without these two Google returns no refresh token on a second
    // connection, and the link silently dies an hour later.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
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

export async function disconnectGoogle(userId) {
  await query(
    `UPDATE staff_users
        SET google_email = NULL, google_refresh_token = NULL, google_access_token = NULL,
            google_expires_at = NULL, google_calendar_id = NULL, google_connected_at = NULL
      WHERE id = $1`,
    [userId],
  );
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

  const calendarId = 'primary';
  const { rows } = await query(
    'SELECT event_id FROM google_events WHERE appointment_id = $1 AND staff_user_id = $2',
    [appt.id, userId],
  );
  const existing = rows[0]?.event_id;

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
    const updated = await call(token, `/calendars/${calendarId}/events/${existing}`,
                               { method: 'PATCH', body });
    // Gone from Google's side: fall through and create it again.
    if (updated) {
      await query('UPDATE google_events SET updated_at = now() WHERE appointment_id = $1 AND staff_user_id = $2',
                  [appt.id, userId]);
      return existing;
    }
  }

  if (appt.status === 'cancelled') return null;   // nothing to recreate

  const created = await call(token, `/calendars/${calendarId}/events`, { method: 'POST', body });
  await query(
    `INSERT INTO google_events (appointment_id, staff_user_id, event_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (appointment_id, staff_user_id)
     DO UPDATE SET event_id = EXCLUDED.event_id, updated_at = now()`,
    [appt.id, userId, created.id],
  );
  return created.id;
}
