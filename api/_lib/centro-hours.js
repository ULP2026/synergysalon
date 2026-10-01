/**
 * Each stylist's free time, as CENTRO sees it.
 *
 * The stylists keep their hours in CENTRO: the calendar's availability for
 * each team member, plus the personal calendars they connected there. So the
 * website asks CENTRO rather than keeping a second copy that drifts. The
 * seeded hours here gave everyone the salon's opening times, and guests
 * booked 9 AM with stylists who do not start until later.
 *
 * Fails closed. A stylist with no CENTRO user linked, or whose free times
 * CENTRO would not give us, is offered nothing online: a guest who cannot
 * book online calls the salon, while a guest booked into a time the stylist
 * is not there turns up to an empty chair.
 */
import { freeSlots, getCalendar, getUserName, slotMinutes } from './ghl.js';

/** CENTRO will not answer for more than about a month at once. */
const CHUNK_DAYS = 28;
/** Long enough to spare CENTRO the same question from one guest's clicks. */
const CACHE_MS = 60 * 1000;

const cache = new Map();

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - CACHE_MS) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}

/**
 * Turn slot start times into free windows.
 *
 * Every start CENTRO lists means [start, start + slot length) is free, so the
 * union of those spans is time the stylist can be booked. A service longer
 * than one slot fits when it lies inside one merged window.
 */
export function mergeWindows(startsMs, slotMin) {
  const len = slotMin * 60 * 1000;
  const out = [];
  for (const s of startsMs) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], s + len);
    else out.push([s, s + len]);
  }
  return out;
}

export function fitsIn(windows, startMs, endMs) {
  for (const [from, to] of windows) {
    if (startMs >= from && endMs <= to) return true;
    if (from > startMs) break;
  }
  return false;
}

/** The link to CENTRO, token included. Read here and never returned. */
async function linkFor(client, tenantId) {
  const { rows } = await client.query(
    `SELECT id, ghl_location_id, ghl_token, ghl_calendar_id, ghl_user_id
       FROM tenants WHERE id = $1::uuid`,
    [tenantId],
  );
  const t = rows[0];
  return t?.ghl_token && t.ghl_calendar_id ? t : null;
}

/**
 * Free windows for each stylist between two instants.
 *
 * Returns Map(stylistId -> windows | null). null means "offer nothing":
 * not linked to a CENTRO user, or CENTRO could not be asked.
 */
export async function centroWindows(client, tenant, stylists, fromMs, toMs) {
  const result = new Map(stylists.map((s) => [s.id, null]));
  const link = await linkFor(client, tenant.id);
  if (!link) return result;

  let slotMin;
  try {
    slotMin = await cached(`cal:${link.ghl_calendar_id}`, async () => slotMinutes(await getCalendar(link)));
  } catch (err) {
    console.error('CENTRO calendar could not be read for availability:', err.message);
    return result;
  }

  await Promise.all(stylists.map(async (s) => {
    if (!s.ghl_user_id) return;
    try {
      const starts = [];
      for (let a = fromMs; a < toMs; a += CHUNK_DAYS * 86400000) {
        const b = Math.min(toMs, a + CHUNK_DAYS * 86400000);
        const got = await cached(`fs:${link.ghl_calendar_id}:${s.ghl_user_id}:${a}:${b}`,
          () => freeSlots(link, { userId: s.ghl_user_id, startMs: a, endMs: b, timezone: tenant.timezone }));
        starts.push(...got);
      }
      starts.sort((x, y) => x - y);
      result.set(s.id, mergeWindows(starts, slotMin));
    } catch (err) {
      console.error(`CENTRO free times failed for stylist ${s.slug}:`, err.message);
    }
  }));
  return result;
}

/**
 * Who each stylist is in CENTRO, and what CENTRO says their next free time
 * is, for Settings. The second half is the proof the link works: if a
 * stylist's next free time matches the hours they set in CENTRO, the website
 * is offering the right times.
 */
export async function stylistLinks(client, tenant) {
  const link = await linkFor(client, tenant.id);
  const { rows: stylists } = await client.query(
    `SELECT id, slug, name, ghl_user_id FROM stylists
      WHERE tenant_id = $1::uuid AND active ORDER BY sort_order`,
    [tenant.id],
  );
  if (!link) return { linked: false, team: [], stylists: [] };

  const calendar = await getCalendar(link);
  const ids = (calendar.teamMembers || []).map((m) => m.userId).filter(Boolean);
  const team = await Promise.all(ids.map(async (id) => ({ id, name: await getUserName(link, id) })));

  const now = Date.now();
  const out = await Promise.all(stylists.map(async (s) => {
    const row = { slug: s.slug, name: s.name, ghlUserId: s.ghl_user_id, onCalendar: ids.includes(s.ghl_user_id) };
    if (!s.ghl_user_id) {
      // Offer the obvious match rather than make somebody read user ids.
      const first = s.name.split(/\s+/)[0].toLowerCase();
      const byFull = team.filter((m) => (m.name || '').toLowerCase() === s.name.toLowerCase());
      const byFirst = team.filter((m) => (m.name || '').toLowerCase().split(/\s+/)[0] === first);
      const suggest = (byFull.length === 1 ? byFull[0] : byFirst.length === 1 ? byFirst[0] : null)?.id || null;
      return { ...row, suggest, next: null, note: 'Not linked, so not offered online.' };
    }
    try {
      const starts = await freeSlots(link, { userId: s.ghl_user_id, startMs: now, endMs: now + 14 * 86400000, timezone: tenant.timezone });
      return { ...row, next: starts[0] ? new Date(starts[0]).toISOString() : null, count: starts.length,
        note: starts.length ? null : 'The CRM shows no free times in the next 14 days.' };
    } catch (err) {
      return { ...row, next: null, note: `The CRM would not say: ${err.message}` };
    }
  }));
  return { linked: true, team, stylists: out };
}
