/**
 * The changes Karen in the app may get ready (asked for 2026-11-14, after
 * Dina asked her to "block off my book on November 26th, 27th and 28th"
 * and was told she couldn't): move an appointment, change a visit's price
 * or add to its notes, block time off or take a block away, change working
 * hours, and change a stylist's own price, minutes or offering of a service.
 *
 * The rule is karen-actions.js's: the model only proposes. Each `check`
 * below asks the same question the app's own screen asks (a move's free
 * times come from the Move window's moveTimes, a block is worked out by
 * addBlock without saving, hours go through readHours, a service through
 * servicesFrom), and returns what the card says. Nothing changes until the
 * person presses Confirm, and then `run` does it through the app's own
 * functions, which check everything again (who may, the overlap rule, the
 * stylist's hours), and its reply is written here, by code.
 *
 * Who may do what is the app's rule, not a new one: the owner (and admins)
 * the whole salon, anyone else only their own chair; a visit's price only
 * the owner, admins and managers (setVisitPrice).
 */
import { DateTime } from 'luxon';

import { canManageTeam } from './auth.js';
import { query, transaction } from './db.js';
import { HttpError } from './http.js';
import { readHours, syncStandalone, syncStylist } from './roster.js';
import { chairOf } from './scope.js';
import { ownPrice, ownTiming } from './timing.js';
import { assertMyAppointment, moveAppointment, moveTimes, setVisitPrice, ticketFor } from '../staff/_routes/appointment.js';
import { addBlock, removeBlock } from '../staff/_routes/diary.js';
import { servicesFrom } from '../staff/_routes/profile.js';

export const CHANGE_TYPES = ['move', 'price', 'note', 'block', 'unblock', 'hours', 'service'];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const PRICE_ROLES = ['owner', 'admin', 'manager'];
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const money = (c) => (c == null ? 'no price' : `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`);
const clock = (t) => DateTime.fromFormat(String(t).slice(0, 5), 'H:mm').toFormat('h:mm a');
const msg = (err) => String(err?.message || err || 'That did not work.');

/** "monday", "Mon", 1 -> 1. */
function weekdayOf(v) {
  if (Number.isInteger(v) && v >= 0 && v <= 6) return v;
  const t = String(v || '').trim().toLowerCase().slice(0, 3);
  const i = DAY_NAMES.findIndex((d) => d.toLowerCase().startsWith(t));
  return t.length >= 2 && i >= 0 ? i : null;
}
/** "9:00", "09:00", "9am", "5:30 pm" -> "09:00" / "17:30"; or null. */
function hhmmOf(v) {
  const t = String(v || '').trim().toLowerCase().replace(/\s+/g, '');
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?(am|pm|a|p)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (m[3]?.startsWith('p') && h < 12) h += 12;
  if (m[3]?.startsWith('a') && h === 12) h = 0;
  const out = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  return HHMM.test(out) ? out : null;
}

/**
 * Free start times as runs: "9:00 AM to 12:45 PM (every 15 min)", one line
 * per run, so the whole day fits in a few lines for the model to offer.
 */
function startRanges(isos, zone) {
  const ts = isos.map((x) => DateTime.fromISO(x).setZone(zone)).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < ts.length;) {
    let j = i;
    const step = ts[i + 1] ? ts[i + 1].diff(ts[i], 'minutes').minutes : 0;
    while (j + 1 < ts.length && ts[j + 1].diff(ts[j], 'minutes').minutes === step && step <= 30) j += 1;
    out.push(j > i ? `${ts[i].toFormat('h:mm a')} to ${ts[j].toFormat('h:mm a')} (every ${step} min)` : ts[i].toFormat('h:mm a'));
    i = j + 1;
  }
  return out;
}

/** The appointment by ref, in this person's reach, or null. */
async function apptFor(tenant, user, ref) {
  const r = String(ref || '').trim().toUpperCase();
  if (!r) return null;
  try { await assertMyAppointment(user, tenant, r); } catch { return null; }
  const { rows } = await query(
    `SELECT a.ref, a.status, a.starts_at, a.guest_name, a.guest_email, a.guest_phone, a.notes,
            c.email AS contact_email, c.phone AS contact_phone, s.name AS stylist_name, s.slug AS stylist_slug
       FROM appointments a JOIN stylists s ON s.id = a.stylist_id
       LEFT JOIN contacts c ON c.id = a.contact_id
      WHERE a.tenant_id = $1::uuid AND a.ref = $2::text`,
    [tenant.id, r],
  );
  return rows[0] || null;
}

/** The stylist by slug, if this person may change them. */
async function stylistFor(tenant, user, slug) {
  const chair = await chairOf(user);
  const s = String(slug || '').trim();
  if (!s) return { error: 'Say which stylist (their slug from the stylists list).' };
  if (chair && !chair.slugs.includes(s)) return { error: 'You can only change your own chair. Only the salon owner can change somebody else\'s.' };
  const { rows } = await query(
    `SELECT s.id, s.slug, s.name, s.staff_user_id, to_jsonb(s) -> 'service_details' AS sdetails,
            u.name AS login_name, u.username, to_jsonb(u) -> 'services' AS udetails
       FROM stylists s LEFT JOIN staff_users u ON u.id = s.staff_user_id
      WHERE s.tenant_id = $1::uuid AND s.slug = $2::text AND (to_jsonb(s) ->> 'removed_at') IS NULL`,
    [tenant.id, s],
  );
  if (!rows[0]) return { error: `No stylist "${s}" on the team.` };
  const st = rows[0];
  return { st, details: (st.staff_user_id ? st.udetails : st.sdetails) || {} };
}

const when = (iso, zone) => DateTime.fromISO(iso, { zone }).setZone(zone).toFormat("ccc, LLL d 'at' h:mm a");

// ── each change: check (nothing saved) and run (after Confirm) ────────────

const CHANGES = {
  move: {
    async check({ tenant, user }, input) {
      const zone = tenant.timezone;
      const a = await apptFor(tenant, user, input.ref);
      if (!a) return { error: 'No appointment with that ref that you can change. Look it up first.' };
      if (a.status !== 'booked') return { error: `That appointment is ${a.status.replace('_', '-')}, so it can't be moved.` };
      const time = hhmmOf(input.time);
      if (!isDay(input.date) || !time) return { error: 'Give the new date as YYYY-MM-DD and the time as HH:MM.' };
      const start = DateTime.fromISO(`${input.date}T${time}`, { zone });
      const slug = input.stylist ? String(input.stylist) : null;
      if (slug) {
        const chair = await chairOf(user);
        if (chair && !chair.slugs.includes(slug)) return { error: 'You can only move it within your own chair.' };
      }
      let free;
      try { free = await moveTimes(tenant, a.ref, input.date, slug); } catch (err) { return { error: msg(err) }; }
      const fits = free.some((x) => DateTime.fromISO(x).toMillis() === start.toMillis());
      if (!fits) {
        return {
          nothing: true,
          reason: `${start.toFormat('h:mm a')} on ${start.toFormat('ccc, LLL d')} isn't free for this visit.`,
          free_that_day: startRanges(free, zone),
        };
      }
      const { rows: [to] } = slug && slug !== a.stylist_slug
        ? await query('SELECT name FROM stylists WHERE tenant_id = $1::uuid AND slug = $2::text', [tenant.id, slug])
        : { rows: [{ name: a.stylist_name }] };
      const reachable = Boolean(a.guest_email || a.contact_email || a.guest_phone || a.contact_phone);
      const notify = input.notify !== false && reachable;
      return {
        title: 'Move this appointment',
        lines: [
          `${a.guest_name}`,
          `From ${when(new Date(a.starts_at).toISOString(), zone)} with ${a.stylist_name}`,
          `To ${start.toFormat("ccc, LLL d 'at' h:mm a")} with ${to?.name || slug}`,
          notify ? 'The client is sent the "your appointment has moved" email (and a text if they agreed to texts).'
            : reachable ? 'The client is not told.' : 'The client has no email or phone on file, so they are not told.',
        ],
        payload: { ref: a.ref, start: start.toISO(), stylist: slug, notify },
      };
    },
    async run({ tenant, user }, p) {
      await assertMyAppointment(user, tenant, p.ref, { toStylist: p.stylist || null });
      const { appt, moved } = await moveAppointment(tenant, user, p.ref, { start: p.start, stylist: p.stylist, notify: p.notify });
      if (!moved) return 'It was already at that time, so nothing changed.';
      const at = DateTime.fromJSDate(new Date(appt.starts_at)).setZone(tenant.timezone).toFormat("ccc, LLL d 'at' h:mm a");
      return `Done. ${appt.guest_name} is now ${at} with ${appt.stylist_name}.${p.notify ? ' They have been sent the reschedule email.' : ''}`;
    },
  },

  price: {
    async check({ tenant, user }, input) {
      if (!PRICE_ROLES.includes(user.role) && !canManageTeam(user)) {
        return { error: 'Only an owner, an admin or a manager can change a price.' };
      }
      const a = await apptFor(tenant, user, input.ref);
      if (!a) return { error: 'No appointment with that ref that you can change. Look it up first.' };
      const t = await ticketFor(tenant, a.ref);
      const cents = (v) => (v == null || v === '' ? null : Math.round(Number(v) * 100));
      const bad = (c) => c != null && (!Number.isFinite(c) || c < 0 || c > 1_000_000);
      if (t.itemized) {
        const list = Array.isArray(input.prices) ? input.prices.map(cents) : null;
        if (!list || list.length !== t.lines.length) {
          return { error: `This visit has ${t.lines.length} services (${t.lines.map((l) => l.name).join(', ')}): give one price for each, in that order.` };
        }
        if (list.some(bad)) return { error: 'Prices are dollar amounts from $0 to $10,000.' };
        if (list.some((c) => c == null) && list.some((c) => c != null)) return { error: 'Give every service a price, or none.' };
        const sum = list.every((c) => c == null) ? null : list.reduce((x, y) => x + y, 0);
        return {
          title: 'Change the price of this visit',
          lines: [
            `${a.guest_name}, ${when(new Date(a.starts_at).toISOString(), tenant.timezone)}`,
            ...t.lines.map((l, i) => `${l.name}: ${money(l.priceCents)}, now ${money(list[i])}`),
            `Total: ${money(t.totalCents)}, now ${money(sum)}`,
          ],
          payload: { ref: a.ref, prices: list },
        };
      }
      const total = cents(input.total ?? (Array.isArray(input.prices) && input.prices.length === 1 ? input.prices[0] : null));
      if (total == null && input.total !== null) return { error: 'This visit was booked before services were itemized: give its total only.' };
      if (bad(total)) return { error: 'Prices are dollar amounts from $0 to $10,000.' };
      return {
        title: 'Change the price of this visit',
        lines: [`${a.guest_name}, ${when(new Date(a.starts_at).toISOString(), tenant.timezone)}`, `Total: ${money(t.totalCents)}, now ${money(total)}`],
        payload: { ref: a.ref, total },
      };
    },
    async run({ tenant, user }, p) {
      const t = await setVisitPrice(tenant, user, p.ref, p.prices ? { prices: p.prices } : { total: p.total });
      return `Done. The visit now comes to ${money(t.totalCents)}.`;
    },
  },

  note: {
    async check({ tenant, user }, input) {
      const a = await apptFor(tenant, user, input.ref);
      if (!a) return { error: 'No appointment with that ref that you can change. Look it up first.' };
      const note = String(input.note || '').trim().slice(0, 1000);
      if (!note) return { error: 'Say what the note should say.' };
      return {
        title: 'Add a note to this appointment',
        lines: [`${a.guest_name}, ${when(new Date(a.starts_at).toISOString(), tenant.timezone)}`, `"${note}"`],
        payload: { ref: a.ref, note },
      };
    },
    async run({ tenant, user }, p) {
      await assertMyAppointment(user, tenant, p.ref);
      const stamp = DateTime.now().setZone(tenant.timezone).toFormat('LLL d');
      await query(
        `UPDATE appointments SET notes = concat_ws(E'\\n', NULLIF(notes, ''), $3::text), updated_at = now()
          WHERE tenant_id = $1::uuid AND ref = $2::text`,
        [tenant.id, p.ref, `${stamp} (${user.name || 'staff'}): ${p.note}`],
      );
      return 'Done. The note is on the appointment.';
    },
  },

  block: {
    async check({ tenant, user }, input) {
      const zone = tenant.timezone;
      const days = (Array.isArray(input.days) ? input.days : []).slice(0, 31);
      if (!days.length) return { error: 'Give the days to block: each a date (YYYY-MM-DD), and from/to times unless it is the whole day.' };
      // Whose time: refused once for the whole request, not day by day.
      const who = await stylistFor(tenant, user, input.stylist);
      if (who.error) return who;
      const reason = String(input.reason || '').trim().slice(0, 120) || 'Blocked';
      const ok = [];
      const skipped = [];
      for (const d of days) {
        const from = d.from ? hhmmOf(d.from) : null;
        const to = d.to ? hhmmOf(d.to) : null;
        if (!isDay(d.date) || (d.from && !from) || (d.to && !to) || Boolean(from) !== Boolean(to)) {
          skipped.push({ date: d.date, why: 'give a date, and both from and to, or neither for the whole day' });
          continue;
        }
        const body = { stylist: input.stylist, date: d.date, reason, kind: 'block', ...(from ? { from, to } : { allDay: true }) };
        try {
          const b = await addBlock(tenant, user, body, null, { dry: true });
          const { rows: [n] } = await query(
            `SELECT count(*)::int AS n FROM appointments WHERE stylist_id = $1::uuid AND status = 'booked'
                AND during && tstzrange($2::timestamptz, $3::timestamptz)`,
            [b.stylistId, b.startsAt, b.endsAt],
          );
          ok.push({ body, b, booked: n.n });
        } catch (err) {
          skipped.push({ date: d.date, why: msg(err) });
        }
      }
      if (!ok.length) return { nothing: true, skipped };
      const t = (iso) => DateTime.fromISO(iso).setZone(zone);
      const booked = ok.reduce((x, o) => x + o.booked, 0);
      return {
        title: `Block ${ok.length === 1 ? 'this time' : `${ok.length} days`} for ${ok[0].b.stylist}`,
        lines: ok.map(({ b }) => `${t(b.startsAt).toFormat('ccc, LLL d')}, ${t(b.startsAt).toFormat('h:mm a')} to ${t(b.endsAt).toFormat('h:mm a')} · ${reason}`),
        note: booked ? `${booked} appointment${booked === 1 ? ' is' : 's are'} already booked in that time and will stay booked: move or cancel ${booked === 1 ? 'it' : 'them'} separately.` : null,
        skipped,
        payload: { blocks: ok.map((o) => o.body) },
      };
    },
    async run({ tenant, user }, p) {
      const done = [];
      const not = [];
      for (const body of p.blocks) {
        try {
          const b = await addBlock(tenant, user, body);
          done.push(DateTime.fromISO(b.startsAt).setZone(tenant.timezone).toFormat('ccc, LLL d'));
        } catch (err) { not.push(`${body.date} (${msg(err)})`); }
      }
      return `${done.length ? `Done. Blocked ${done.join(', ')}; nothing can be booked in that time now.` : "I couldn't block any of it."}${not.length ? ` Not done: ${not.join('; ')}.` : ''}`;
    },
  },

  unblock: {
    async check({ tenant, user }, input) {
      const ids = (Array.isArray(input.ids) ? input.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 60);
      if (!ids.length) return { error: 'Give the block ids from the blocks look-up.' };
      const chair = await chairOf(user);
      const { rows } = await query(
        `SELECT t.id, t.reason, lower(t.during) AS a, upper(t.during) AS b, s.name
           FROM time_off t LEFT JOIN stylists s ON s.id = t.stylist_id
          WHERE t.tenant_id = $1::uuid AND t.id = ANY($2::int[])
            AND ($3::uuid[] IS NULL OR t.stylist_id = ANY($3::uuid[]))
          ORDER BY lower(t.during)`,
        [tenant.id, ids, chair ? chair.ids : null],
      );
      if (!rows.length) return { error: 'None of those blocks are ones you can remove.' };
      const t = (d) => DateTime.fromJSDate(new Date(d)).setZone(tenant.timezone);
      return {
        title: `Remove ${rows.length === 1 ? 'this block' : `${rows.length} blocks`}`,
        lines: rows.map((r) => `${r.name || 'Whole salon'}: ${t(r.a).toFormat('ccc, LLL d, h:mm a')} to ${t(r.b).toFormat('h:mm a')} · ${r.reason}`),
        note: 'That time can be booked again once they are gone.',
        payload: { ids: rows.map((r) => r.id) },
      };
    },
    async run({ tenant, user }, p) {
      let n = 0;
      const not = [];
      for (const id of p.ids) {
        try { await removeBlock(tenant, user, id); n += 1; } catch (err) { not.push(msg(err)); }
      }
      return `${n ? `Done. ${n === 1 ? 'The block is' : `${n} blocks are`} gone.` : "I couldn't remove any of them."}${not.length ? ` ${not.join(' ')}` : ''}`;
    },
  },

  hours: {
    async check({ tenant, user }, input) {
      const found = await stylistFor(tenant, user, input.stylist);
      if (found.error) return found;
      const { st } = found;
      const days = Array.isArray(input.days) ? input.days.slice(0, 7) : [];
      if (!days.length) return { error: 'Give the days to change: each a weekday and its shifts (from, to), or no shifts for a day off.' };
      const { rows: now } = await query(
        `SELECT weekday, to_char(starts_at, 'HH24:MI') AS starts, to_char(ends_at, 'HH24:MI') AS ends
           FROM stylist_hours WHERE stylist_id = $1::uuid ORDER BY weekday, starts_at`,
        [st.id],
      );
      const changed = new Map();
      for (const d of days) {
        const wd = weekdayOf(d.weekday);
        if (wd == null) return { error: `"${d.weekday}" is not a day of the week.` };
        const shifts = (Array.isArray(d.shifts) ? d.shifts : []).map((x) => ({ starts: hhmmOf(x.from), ends: hhmmOf(x.to) }));
        if (shifts.some((x) => !x.starts || !x.ends)) return { error: 'Give each shift as from and to times, like 09:00 and 17:00.' };
        changed.set(wd, shifts);
      }
      const week = [...now.filter((r) => !changed.has(r.weekday)),
        ...[...changed].flatMap(([weekday, shifts]) => shifts.map((x) => ({ weekday, ...x })))];
      let hours;
      try { hours = readHours(week); } catch (err) { return { error: msg(err) }; }
      const say = (list) => (list.length ? list.map((x) => `${clock(x.starts)} to ${clock(x.ends)}`).join(', ') : 'off');
      return {
        title: `Change ${st.name}'s working hours`,
        lines: [...changed.keys()].sort().map((wd) => `${DAY_NAMES[wd]}: ${say(now.filter((r) => r.weekday === wd))}, now ${say(changed.get(wd))}`),
        note: 'These are the hours clients can book. Appointments already booked stay where they are.',
        payload: { stylistId: st.id, slug: st.slug, hours, days: [...changed.keys()] },
      };
    },
    async run({ tenant, user }, p) {
      const found = await stylistFor(tenant, user, p.slug);
      if (found.error) throw new HttpError(403, found.error);
      const hours = readHours(p.hours);
      await transaction(async (c) => {
        await c.query('DELETE FROM stylist_hours WHERE stylist_id = $1::uuid', [p.stylistId]);
        if (hours.length) {
          await c.query(
            `INSERT INTO stylist_hours (stylist_id, weekday, starts_at, ends_at)
             SELECT $1, w, s::time, e::time FROM unnest($2::int[], $3::text[], $4::text[]) AS t(w, s, e)`,
            [p.stylistId, hours.map((h) => h.weekday), hours.map((h) => h.starts), hours.map((h) => h.ends)],
          );
        }
      });
      return `Done. ${found.st.name}'s hours for ${p.days.sort().map((d) => DAY_NAMES[d]).join(', ')} are saved.`;
    },
  },

  service: {
    async check({ tenant, user }, input) {
      const found = await stylistFor(tenant, user, input.stylist);
      if (found.error) return found;
      const { st, details } = found;
      const changes = Array.isArray(input.changes) ? input.changes.slice(0, 30) : [];
      if (!changes.length) return { error: 'Give the changes: each a service slug with its new price (dollars), minutes, or on/off.' };
      const { rows: menu } = await query(
        'SELECT slug, name, category, duration_min, price_cents FROM services WHERE tenant_id = $1::uuid AND active',
        [tenant.id],
      );
      const items = { ...(details.items || {}) };
      const lines = [];
      for (const ch of changes) {
        const svc = menu.find((m) => m.slug === ch.service);
        if (!svc) return { error: `No service "${ch.service}" on the menu. Use a slug from the services list.` };
        const item = { ...(items[svc.slug] || {}) };
        const was = { price: ownPrice(details, svc) ?? svc.price_cents, mins: ownTiming(details, svc)?.durationMin ?? svc.duration_min, on: item.on !== false };
        const parts = [];
        if (ch.price !== undefined) {
          const n = ch.price === null || ch.price === '' ? null : Number(ch.price);
          if (n != null && (!Number.isFinite(n) || n < 0 || n > 10000)) return { error: 'A price is a number of dollars, up to 10,000.' };
          if (n == null) delete item.price; else item.price = Math.round(n * 100) / 100;
          parts.push(`price ${money(was.price)}, now ${n == null ? 'none of its own' : money(Math.round(n * 100))}`);
        }
        if (ch.minutes !== undefined) {
          if (svc.category === 'color') {
            return { error: `${svc.name} is timed in Start, Break and Finish. Change those in Settings, My Settings (or the stylist's window in Team).` };
          }
          const m = Number(ch.minutes);
          if (!Number.isInteger(m) || m < 5 || m > 720) return { error: 'Minutes are a whole number from 5 to 720.' };
          item.duration = m;
          parts.push(`${was.mins} minutes, now ${m}`);
        }
        if (ch.on !== undefined) {
          item.on = Boolean(ch.on);
          if (item.on !== was.on) parts.push(item.on ? 'offered again' : 'no longer offered');
        }
        if (!parts.length) continue;
        items[svc.slug] = item;
        lines.push(`${svc.name}: ${parts.join(', ')}`);
      }
      if (!lines.length) return { nothing: true, reason: 'Nothing would change.' };
      let next;
      try { next = servicesFrom({ ...details, items }); } catch (err) { return { error: msg(err) }; }
      return {
        title: `Change ${st.login_name || st.name}'s services`,
        lines,
        note: 'New bookings with them use these from now on; visits already booked keep their price and length.',
        payload: { slug: st.slug, services: next },
      };
    },
    async run({ tenant, user }, p) {
      const found = await stylistFor(tenant, user, p.slug);
      if (found.error) throw new HttpError(403, found.error);
      const { st } = found;
      const services = servicesFrom(p.services);
      await transaction(async (c) => {
        if (st.staff_user_id) {
          await c.query('UPDATE staff_users SET services = $2::jsonb WHERE id = $1::uuid', [st.staff_user_id, JSON.stringify(services)]);
          await syncStylist(c, tenant.id, { id: st.staff_user_id, name: st.login_name || st.name, username: st.username }, { services });
        } else {
          await syncStandalone(c, tenant.id, st.id, { services });
        }
      });
      return `Done. ${st.login_name || st.name}'s services are updated.`;
    },
  },
};

/** Check one change; returns { title, lines, note, skipped, payload } or { error } / { nothing }. */
export async function checkChange(ctx, input) {
  const kind = CHANGES[input.type];
  if (!kind) return { error: `Karen can't do "${input.type}".` };
  try {
    return await kind.check(ctx, input);
  } catch (err) {
    if (err?.status) return { error: msg(err) };
    throw err;
  }
}

/** Carry out a confirmed change; returns what to say, written here. */
export async function runChange(ctx, type, payload) {
  try {
    return { say: await CHANGES[type].run(ctx, payload), done: true };
  } catch (err) {
    if (err?.status) return { say: `That didn't go through: ${msg(err)}`, done: false };
    throw err;
  }
}
