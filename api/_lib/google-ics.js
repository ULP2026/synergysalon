/**
 * A team member's Google Calendar, read from its private iCal address.
 *
 * Signing in with Google (google.js) needs an OAuth client the site does not
 * have yet, which left the Connect button greyed out and nothing anybody
 * could fill in. Every Google Calendar also has a "Secret address in iCal
 * format" (Settings, the calendar, Integrate calendar). Pasted into Connect
 * your tools, it lets Appt. Book show that person's busy times today, with no
 * Google setup on our side at all.
 *
 * Only times leave this file. The feed carries titles and descriptions too;
 * they are parsed past and never returned, so Appt. Book shows "Busy" exactly
 * as it does for a signed-in connection.
 *
 * The address is a credential: anybody holding it can read that calendar. It
 * is stored encrypted when TOKEN_KEY is set, and accepted only for
 * calendar.google.com so the server cannot be pointed at anything else.
 */
import ICAL from 'ical.js';
import { DateTime } from 'luxon';

import { canStoreSecrets, decryptSecret, encryptSecret } from './secrets.js';

/**
 * Read whatever was pasted into a Google Calendar iCal address, or say what
 * was pasted instead.
 *
 * People paste what they find. The first version accepted only the exact
 * https address and answered everything else with the same sentence, so a
 * calendar ID, the public link or an address with a stray quote all looked
 * like "it doesn't work". Each common mistake now has its own answer, and
 * the forgivable ones (spaces, quotes, webcal://, no https://) are fixed.
 *
 * Returns { ok: true, url, account, isPrivate } or { ok: false, reason }.
 */
export function readIcsLink(raw) {
  let text = String(raw || '').trim().replace(/^[<"'`\s]+|[>"'`\s]+$/g, '');
  if (!text) return { ok: false, reason: 'Paste your calendar’s Secret address in iCal format.' };

  // A calendar ID (an email address, or Google's long group id) is not an
  // address Google will serve; it is the most common thing pasted.
  if (/^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(text)) {
    return { ok: false, reason: 'That is your calendar ID, not its address. In Google Calendar settings, under Integrate calendar, copy “Secret address in iCal format” instead.' };
  }
  // A link pasted inside other text: take the Google address out of it.
  const found = text.match(/(?:https?|webcal):\/\/calendar\.google\.com\/\S+/i)
    || text.match(/calendar\.google\.com\/\S+/i);
  if (found) text = found[0];
  text = text.replace(/^webcal:\/\//i, 'https://').replace(/^http:\/\//i, 'https://');
  if (!/^https:\/\//i.test(text)) text = `https://${text}`;

  let url;
  try { url = new URL(text); } catch {
    return { ok: false, reason: 'That is not a web address. Copy “Secret address in iCal format” from Google Calendar settings.' };
  }
  if (url.hostname !== 'calendar.google.com') {
    return { ok: false, reason: 'That is not a Google Calendar address. It should start with https://calendar.google.com/calendar/ical/' };
  }
  if (/\/calendar\/(embed|u\/\d+\/r|r)\b/.test(url.pathname) || url.searchParams.has('src') || url.searchParams.has('cid')) {
    return { ok: false, reason: 'That is the link for viewing the calendar in a browser. Under Integrate calendar, copy “Secret address in iCal format” instead.' };
  }
  const m = url.pathname.match(/^\/calendar\/ical\/([^/]+)\/([^/]+)\/basic\.ics$/);
  if (!m) {
    return { ok: false, reason: 'That address looks cut short. Copy the whole “Secret address in iCal format”; it ends in /basic.ics' };
  }
  let account = '';
  try { account = decodeURIComponent(m[1]); } catch { account = m[1]; }
  url.search = '';
  url.hash = '';
  return { ok: true, url: url.toString(), account, isPrivate: m[2].startsWith('private-') };
}

/** The address, if it is one; for reading back what is already stored. */
export function parseIcsLink(raw) {
  const r = readIcsLink(raw);
  return r.ok ? { url: r.url, account: r.account, isPrivate: r.isPrivate } : null;
}

/**
 * Ask Google for the feed and read today from it, as Appt. Book will, so a
 * calendar is only called connected once it has actually been read. Says in
 * plain words what Google answered when it is not a calendar.
 */
export async function checkIcsLink(link, zone) {
  let res;
  try {
    res = await fetch(link.url, { signal: AbortSignal.timeout(15_000), redirect: 'follow', headers: { Accept: 'text/calendar' } });
  } catch (err) {
    return { ok: false, why: `network: ${err.name}`, reason: 'Google did not answer in time. Check your connection and press Connect again.' };
  }
  if (res.status === 404) {
    return {
      ok: false, why: '404',
      reason: link.isPrivate
        ? 'Google has no calendar at that address. If the secret address was reset, copy the new one from Google Calendar settings.'
        : 'That is the public address, and this calendar is not public. Copy “Secret address in iCal format” instead.',
    };
  }
  if (res.status === 400) {
    return { ok: false, why: '400', reason: 'Google says that address is incomplete. Copy the whole “Secret address in iCal format” again.' };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, why: String(res.status), reason: 'Google refused to share this calendar. A work Google account may have secret addresses turned off by its administrator.' };
  }
  if (!res.ok) return { ok: false, why: String(res.status), reason: `Google answered with an error (${res.status}). Try again in a minute.` };
  const text = await res.text();
  if (!text.startsWith('BEGIN:VCALENDAR')) {
    return { ok: false, why: 'not-ics', reason: 'That address did not return a calendar. Copy “Secret address in iCal format” from Google Calendar settings.' };
  }
  cache.set(link.url, { at: Date.now(), text });
  try {
    const now = DateTime.now().setZone(zone);
    await icsBusyBetween(link.url, now.startOf('day').toISO(), now.endOf('day').toISO(), zone);
  } catch (err) {
    return { ok: false, why: `parse: ${err.message}`, reason: 'Google sent the calendar but it could not be read. Please tell your web team.' };
  }
  return { ok: true };
}

/** Encrypted when the site can, so a database copy is not a set of calendars. */
export function sealLink(url) {
  return canStoreSecrets() ? encryptSecret(url) : url;
}

export function openLink(stored) {
  if (!stored) return null;
  return String(stored).startsWith('v1.') ? decryptSecret(stored) : stored;
}

// A feed is fetched once per couple of minutes per warm function, not once
// per day the front desk clicks through.
const cache = new Map();
const TTL_MS = 2 * 60_000;
const MAX_BYTES = 8 * 1024 * 1024;

async function fetchFeed(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.text;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'follow', headers: { Accept: 'text/calendar' } });
  if (res.status === 404 || res.status === 403) {
    throw new Error('Google no longer accepts this calendar address. It may have been reset.');
  }
  if (!res.ok) throw new Error(`Google Calendar answered ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('That calendar is too large to read.');
  if (!text.startsWith('BEGIN:VCALENDAR')) throw new Error('That address did not return a calendar.');
  cache.set(url, { at: Date.now(), text });
  return text;
}

/**
 * An ICAL.Time as an instant. All-day dates are that day on the salon's
 * clock; floating times (no zone in the feed) are read on it too, since
 * the server's own clock is UTC and means nothing to the salon.
 */
function instant(t, zone) {
  if (t.isDate || !t.zone || t.zone.tzid === 'floating') {
    return DateTime.fromObject(
      { year: t.year, month: t.month, day: t.day, hour: t.isDate ? 0 : t.hour, minute: t.isDate ? 0 : t.minute },
      { zone },
    ).toJSDate();
  }
  return t.toJSDate();
}

function counts(component) {
  const status = String(component.getFirstPropertyValue('status') || '').toUpperCase();
  const transp = String(component.getFirstPropertyValue('transp') || '').toUpperCase();
  // Cancelled is gone; "show me as available" is in the calendar but is not
  // a reason to call them busy.
  return status !== 'CANCELLED' && transp !== 'TRANSPARENT';
}

/**
 * Busy spans overlapping [fromIso, toIso), in the same shape as busyBetween
 * in google.js, so Appt. Book draws both the same way.
 */
export async function icsBusyBetween(link, fromIso, toIso, zone) {
  const text = await fetchFeed(link);
  const cal = new ICAL.Component(ICAL.parse(text));
  for (const vtz of cal.getAllSubcomponents('vtimezone')) {
    try { ICAL.TimezoneService.register(vtz); } catch { /* a zone we cannot read is read as floating */ }
  }

  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  const out = [];
  const push = (startT, endT, item) => {
    if (!counts(item)) return;
    const s = instant(startT, zone).getTime();
    const e = instant(endT, zone).getTime();
    if (s < to && e > from) {
      out.push({ allDay: Boolean(startT.isDate), startsAt: new Date(s).toISOString(), endsAt: new Date(e).toISOString() });
    }
  };

  // Moved or edited occurrences of a repeating event come as their own
  // VEVENTs carrying a RECURRENCE-ID; they are attached to the series so the
  // series yields the edited time instead of the original.
  const events = cal.getAllSubcomponents('vevent').map((v) => new ICAL.Event(v));
  const masters = new Map();
  for (const ev of events) if (!ev.isRecurrenceException()) masters.set(ev.uid, ev);
  for (const ev of events) {
    if (ev.isRecurrenceException()) {
      const m = masters.get(ev.uid);
      if (m) m.relateException(ev); else masters.set(`${ev.uid}#${ev.recurrenceId}`, ev);
    }
  }

  for (const ev of masters.values()) {
    if (!ev.startDate) continue;
    const end = ev.endDate || ev.startDate;
    if (!ev.isRecurring()) { push(ev.startDate, end, ev.component); continue; }
    const it = ev.iterator();
    // A daily event begun years ago is a few thousand steps; the cap is for
    // a malformed rule that never ends.
    for (let i = 0, next; i < 20_000 && (next = it.next()); i += 1) {
      const d = ev.getOccurrenceDetails(next);
      if (instant(d.startDate, zone).getTime() >= to) break;
      push(d.startDate, d.endDate, d.item.component);
    }
  }
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}
