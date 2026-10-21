/**
 * A thin, read-only client for the CENTRO / GoHighLevel v2 API.
 *
 * Read-only on purpose. Nothing is sent to CENTRO any more: the salon asked
 * on 21 October 2026 for its client records to stop going there, and with
 * them went every booking, change and cancellation, which CENTRO will only
 * take attached to a contact. What is left asks CENTRO questions -- a
 * stylist's free time, the calendar's slot length, whether the link works --
 * and never tells it anything. Every function that wrote is gone rather than
 * switched off, so nothing can quietly start writing again.
 */
const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

class GhlError extends Error {
  constructor(status, body, path) {
    super(`GoHighLevel ${path} returned ${status}: ${String(body).slice(0, 300)}`);
    this.status = status;
    /** 4xx other than 429 will fail the same way next time; do not keep retrying. */
    this.permanent = status >= 400 && status < 500 && status !== 429;
  }
}

async function call(tenant, method, path, body) {
  if (!tenant.ghl_token || !tenant.ghl_location_id) {
    throw new GhlError(400, 'tenant has no CENTRO credentials', path);
  }

  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${tenant.ghl_token}`,
      Version: VERSION,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });

  const text = await res.text();
  if (!res.ok) throw new GhlError(res.status, text, path);
  return text ? JSON.parse(text) : {};
}

/** The calendar itself: its team, and the length of the slots it offers. */
export async function getCalendar(tenant) {
  const { calendar } = await call(tenant, 'GET', `/calendars/${tenant.ghl_calendar_id}`);
  return calendar || {};
}

/** A CENTRO user's name, or null when the token may not read users. */
export async function getUserName(tenant, userId) {
  try {
    const u = await call(tenant, 'GET', `/users/${userId}`);
    const name = u?.name || [u?.firstName, u?.lastName].filter(Boolean).join(' ');
    return name || null;
  } catch {
    return null;
  }
}

/**
 * When CENTRO says one team member can be booked, as slot start times.
 *
 * This is the stylist's own availability as CENTRO knows it: the hours set on
 * the calendar for that person, anything already on their CENTRO calendar,
 * and the busy times of any calendar they connected there (Google, Outlook).
 * The website used to offer every stylist the salon's opening hours, which is
 * how a guest booked 9 AM with somebody who starts at 10.
 *
 * CENTRO answers with a map of date to { slots: [...] }; the parsing accepts
 * the shapes it has used (plain ISO strings, or objects carrying the time)
 * and ignores anything else rather than guessing.
 */
export async function freeSlots(tenant, { userId, startMs, endMs, timezone }) {
  const q = new URLSearchParams({
    startDate: String(startMs),
    endDate: String(endMs),
    timezone,
    userId,
  });
  const data = await call(tenant, 'GET', `/calendars/${tenant.ghl_calendar_id}/free-slots?${q}`);
  return parseFreeSlots(data);
}

export function parseFreeSlots(data) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.slots)) {
      for (const s of node.slots) {
        const iso = typeof s === 'string' ? s : (s?.slot || s?.startTime || s?.start);
        const ms = iso ? Date.parse(iso) : NaN;
        if (Number.isFinite(ms)) out.push(ms);
      }
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'traceId') continue;
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) || k === '_dates_') visit(v);
    }
  };
  visit(data);
  return [...new Set(out)].sort((a, b) => a - b);
}

/** A calendar's slot length in minutes, from however CENTRO expressed it. */
export function slotMinutes(calendar) {
  const n = Number(calendar?.slotDuration) || 30;
  return /hour/i.test(calendar?.slotDurationUnit || '') ? n * 60 : n;
}

/**
 * Prove the stored credentials still reach the right sub-account and
 * calendar, and that the stylists mapped to it are on it: the free-time
 * questions above are asked of that calendar, for those people.
 */
export async function checkConnection(tenant, userIds = []) {
  const out = { ok: false, location: null, calendar: null, problems: [] };
  try {
    const { location } = await call(tenant, 'GET', `/locations/${tenant.ghl_location_id}`);
    out.location = { id: location?.id, name: location?.name, timezone: location?.timezone };
  } catch (err) {
    out.problems.push(`The CRM sub-account could not be reached: ${err.message}`);
    return out;
  }
  if (!tenant.ghl_calendar_id) {
    out.problems.push('No CRM calendar is linked.');
    return out;
  }
  try {
    const { calendar } = await call(tenant, 'GET', `/calendars/${tenant.ghl_calendar_id}`);
    const members = (calendar?.teamMembers || []).map((m) => m.userId);
    out.calendar = {
      id: calendar?.id, name: calendar?.name, type: calendar?.calendarType,
      active: calendar?.isActive !== false, teamMembers: members.length,
    };
    if (calendar?.locationId && calendar.locationId !== tenant.ghl_location_id) {
      out.problems.push('The linked calendar belongs to a different CRM sub-account.');
    }
    if (!members.length) {
      out.problems.push('The CRM calendar has no team members, so it has no free time to give.');
    }
    const strangers = [...new Set(userIds.filter(Boolean))].filter((u) => !members.includes(u));
    if (members.length && strangers.length) {
      out.problems.push(`${strangers.length} stylist mapping(s) point at a CRM user who is not on this calendar.`);
    }
  } catch (err) {
    out.problems.push(`The CRM calendar could not be read: ${err.message}`);
    return out;
  }
  out.ok = out.problems.length === 0;
  return out;
}

export { GhlError };
