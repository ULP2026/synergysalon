/**
 * The salon's Hours of Operation (asked for 2026-11-06): when the salon is
 * open, set on Settings, Salon, and shown wherever the salon's details are
 * (Settings, the website's "Open today", the foot of every email, Karen).
 *
 * Stored on `tenants.hours` (055) as seven entries, Sunday first, each
 * `{ open: 'HH:MM', close: 'HH:MM' }` or null for closed. Never set, it is
 * the hours the website showed before this existed, so nothing changes until
 * the salon edits them.
 *
 * These are the salon's opening hours, for people to read. What a guest can
 * book is still each stylist's own Available Hours.
 */
import { HttpError } from './http.js';

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Monday to Sunday, the order a week is read in. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

/** What the website said before the salon could set them (index.html, 2026-11-06). */
export const DEFAULT_SALON_HOURS = [
  null,
  { open: '09:00', close: '15:00' },
  { open: '09:00', close: '15:00' },
  { open: '09:00', close: '19:00' },
  { open: '09:00', close: '19:00' },
  { open: '09:00', close: '18:00' },
  { open: '09:00', close: '15:00' },
];

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutes = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/** The stored hours, or the defaults where there are none or they are not readable. */
export function salonHours(stored) {
  const list = typeof stored === 'string' ? (() => { try { return JSON.parse(stored); } catch { return null; } })() : stored;
  if (!Array.isArray(list) || list.length !== 7) return DEFAULT_SALON_HOURS;
  return list.map((d) => (d && HM.test(d.open) && HM.test(d.close) && minutes(d.close) > minutes(d.open)
    ? { open: d.open, close: d.close } : null));
}

/** Hours as sent from Settings: seven days, each closed or opening before it closes. */
export function hoursFrom(value) {
  if (!Array.isArray(value) || value.length !== 7) throw new HttpError(400, 'Send the hours for all seven days.');
  return value.map((d, i) => {
    if (!d || d.closed) return null;
    const open = String(d.open || '');
    const close = String(d.close || '');
    if (!HM.test(open) || !HM.test(close)) throw new HttpError(400, `Give ${DAY_NAMES[i]} an opening and a closing time, or mark it Closed.`);
    if (minutes(close) <= minutes(open)) throw new HttpError(400, `${DAY_NAMES[i]} closes before it opens.`);
    return { open, close };
  });
}

/** 9 AM, 3:30 PM. */
export function clock(hm) {
  const m = minutes(hm);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h % 12 || 12}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

/** 9a, 3:30p: the website's own way of writing a time. */
export function shortClock(hm) {
  const m = minutes(hm);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h % 12 || 12}${mm ? `:${String(mm).padStart(2, '0')}` : ''}${h < 12 ? 'a' : 'p'}`;
}

/**
 * The week in a few lines, days with the same hours run together:
 * ["Mon–Tue 9 AM – 3 PM", "Wed–Thu 9 AM – 7 PM", ..., "Sun Closed"].
 */
export function hoursLines(hours) {
  const h = salonHours(hours);
  const said = (d) => (d ? `${clock(d.open)} – ${clock(d.close)}` : 'Closed');
  const out = [];
  for (const i of WEEK) {
    const text = said(h[i]);
    const last = out[out.length - 1];
    if (last && last.text === text && WEEK.indexOf(i) === WEEK.indexOf(last.to) + 1) last.to = i;
    else out.push({ from: i, to: i, text });
  }
  return out.map((g) => `${SHORT[g.from]}${g.to !== g.from ? `–${SHORT[g.to]}` : ''} ${g.text}`);
}

/** For the website: each short day name to its hours as the site writes them, or "closed". */
export function websiteHours(hours) {
  const h = salonHours(hours);
  return Object.fromEntries(SHORT.map((name, i) => [name, h[i] ? `${shortClock(h[i].open)} to ${shortClock(h[i].close)}` : 'closed']));
}
