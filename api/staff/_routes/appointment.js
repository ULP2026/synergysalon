/**
 * POST /api/staff/appointment: what the front desk does to a booking.
 * GET  ?ref=: the booking as a ticket -- the whole visit in one place.
 *
 *   check_in | undo_check_in | complete | no_show | cancel | reopen | delete
 *   move ({ start, stylist? }): dragged to a new time or chair on Appt. Book
 *   price ({ prices } or { total }): the price typed on the ticket
 *   services ({ services: [slug...] }): add, remove or change the visit's services
 *
 * Cancelling is the only action that gives the slot back. A completed or
 * no-show appointment still occupied the stylist's time, and letting the
 * diary re-sell it would rewrite history.
 *
 * Delete is not a tidier cancel. Cancelling is what happened -- the guest
 * called off, and the salon should be able to see that they did. Deleting is
 * for a booking that should never have existed: a test, or a duplicate the
 * system created. It leaves nothing behind, which is why only an owner or a
 * manager may do it.
 */
import { DateTime } from 'luxon';

import { availableSlots } from '../../_lib/availability.js';
import { assertSameOrigin, canManageTeam, requireStaff } from '../../_lib/auth.js';
import { chairOf, inChair } from '../../_lib/scope.js';
import { EXCLUSION_VIOLATION, hasColumn, query, transaction } from '../../_lib/db.js';
import { mirrorToGoogle, removeGoogleCopies } from '../../_lib/google-mirror.js';
import { sendCancellation, sendReschedule } from '../../_lib/email.js';
import { at, cancelFor, enqueue } from '../../_lib/scheduled.js';
import {
  HttpError, handler, json, readJson, requireDate, requireString,
} from '../../_lib/http.js';
import { tenantForUser } from '../../_lib/tenant.js';
import { visitLines, visitLinesSql, visitNameSql } from '../../_lib/visit.js';
import { logChanges } from './contacts.js';

/** Same bar as deleting a contact: this removes history outright. */
const CAN_DELETE = ['owner', 'admin', 'manager'];

/**
 * One visit as a ticket: who, with whom, when, every service on it with its
 * price, and what was paid.
 *
 * The appointment is the reservation in the diary; the ticket is the visit
 * on paper. They are the same row, so the Appt. Book and a client's history
 * open the same thing and cannot disagree.
 *
 * Nothing is filled in that the database does not hold. A visit booked
 * before its services were itemized (migration 031) shows its first service
 * and the visit total, and says it is not itemized, rather than putting the
 * whole price against one line. Payments are not recorded anywhere yet, so
 * the ticket says that too, and lists no transactions.
 */
export async function ticketFor(tenant, ref, db = null) {
  const { rows } = await (db ? db.query.bind(db) : query)(
    `SELECT a.ref, a.starts_at, a.duration_min, a.status, a.channel, a.checked_in_at,
            to_jsonb(a) ->> 'booked_via' AS via,
            a.cancelled_at, a.created_at, a.price_cents, a.notes, a.contact_id,
            a.guest_name, a.guest_email, a.guest_phone,
            to_jsonb(a) -> 'services' AS lines, to_jsonb(a) -> 'breaks' AS breaks,
            s.name AS stylist_name, s.slug AS stylist_slug,
            ${visitNameSql()} AS service_name, v.slug AS service_slug,
            b.name AS booked_by_name,
            c.name AS contact_name, c.phone AS contact_phone, c.email AS contact_email,
            (SELECT min(n.starts_at) FROM appointments n
              WHERE n.contact_id = a.contact_id AND n.status = 'booked'
                AND n.starts_at > a.starts_at) AS next_starts_at
       FROM appointments a
       JOIN stylists s ON s.id = a.stylist_id
       JOIN services v ON v.id = a.service_id
       LEFT JOIN staff_users b ON b.id = a.booked_by
       LEFT JOIN contacts c ON c.id = a.contact_id
      WHERE a.ref = $1::text AND a.tenant_id = $2::uuid`,
    [ref, tenant.id],
  );
  const r = rows[0];
  if (!r) return null;

  const starts = DateTime.fromJSDate(new Date(r.starts_at)).setZone(tenant.timezone);
  // Every service of the visit: itemized when it was booked with its lines
  // (031), else each one named from the visit's record, unpriced (visit.js).
  const saved = Array.isArray(r.lines) && r.lines.length ? r.lines : null;
  const lines = visitLines(saved, r.service_name);

  return {
    ref: r.ref,
    status: r.status,
    checkedInAt: r.checked_in_at,
    cancelledAt: r.cancelled_at,
    startsAt: r.starts_at,
    date: starts.toISODate(),
    time: starts.toFormat('h:mm a'),
    endTime: starts.plus({ minutes: r.duration_min }).toFormat('h:mm a'),
    durationMin: r.duration_min,
    breaks: Array.isArray(r.breaks) ? r.breaks : [],
    channel: r.channel,
    via: r.via || null,
    bookedBy: r.booked_by_name,
    createdAt: r.created_at,
    notes: r.notes,
    nextStartsAt: r.next_starts_at,
    stylist: r.stylist_name,
    stylistSlug: r.stylist_slug,
    // The client as the salon knows them now, else as they were booked.
    contactId: r.contact_id,
    guestName: r.contact_name || r.guest_name,
    guestPhone: r.contact_phone || r.guest_phone,
    guestEmail: r.contact_email || r.guest_email,
    service: lines.map((l) => l.name).join(' + '),
    lines,
    // Which services they are, for editing them on the ticket: the itemized
    // list's own, else the visit's first service.
    serviceSlugs: saved ? saved.map((l) => l?.slug).filter(Boolean) : [r.service_slug],
    itemized: Boolean(saved),
    totalCents: r.price_cents,
    price: r.price_cents == null ? null : r.price_cents / 100,
    // No payment is recorded by this app yet (Stripe is not connected), so
    // there is nothing to say but that.
    payment: { status: 'not_tracked' },
    transactions: [],
  };
}

/**
 * Check in, no-show, done, cancel, reopen or delete one appointment, with
 * the emails, follow-ups and Google copy that go with it. The buttons on
 * the appointment window call it through POST below, and Karen in the app
 * calls it once the person has confirmed (karen-actions.js), so both do
 * exactly the same thing.
 */
export async function applyAppointmentAction(tenant, user, ref, action) {
  const result = await transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT a.*, s.name AS stylist_name, ${visitNameSql()} AS service_name, ${visitLinesSql()} AS lines
         FROM appointments a
         JOIN stylists s ON s.id = a.stylist_id
         JOIN services v ON v.id = a.service_id
        WHERE a.ref = $1 AND a.tenant_id = $2
        FOR NO KEY UPDATE OF a`,
      [ref, tenant.id],
    );
    const appt = rows[0];
    if (!appt) throw new HttpError(404, 'No appointment with that reference.');

    // Carries the joined names through, so the cancellation email can say
    // what was cancelled without a second query or a value from the client.
    const set = async (sql, params = []) => {
      const r = await client.query(
        `UPDATE appointments SET ${sql}, updated_at = now() WHERE id = $1 RETURNING *`,
        [appt.id, ...params],
      );
      return {
        ...r.rows[0],
        stylist_name: appt.stylist_name,
        service_name: appt.service_name,
        lines: appt.lines,
      };
    };

    const mark = async (sql) => ({ appt: await set(sql) });

    switch (action) {
      case 'check_in':
        return mark('checked_in_at = COALESCE(checked_in_at, now())');
      case 'undo_check_in':
        return mark('checked_in_at = NULL');
      case 'complete':
        return mark("status = 'completed'");
      case 'no_show':
        return mark("status = 'no_show'");

      case 'cancel': {
        if (appt.status === 'cancelled') {
          throw new HttpError(409, 'That appointment is already cancelled.');
        }
        const updated = await set("status = 'cancelled', cancelled_at = now()");
        return { appt: updated, cancelled: true };
      }

      case 'reopen': {
        if (appt.status !== 'cancelled') {
          throw new HttpError(409, 'That appointment is not cancelled.');
        }
        try {
          // The slot was released when it was cancelled, so somebody else
          // may have taken it in the meantime. The constraint says so.
          const updated = await set("status = 'booked', cancelled_at = NULL");
          return { appt: updated };
        } catch (err) {
          if (err.code === EXCLUSION_VIOLATION) {
            throw new HttpError(409, 'That time has been taken by someone else since it was cancelled.');
          }
          throw err;
        }
      }

      case 'delete': {
        if (!CAN_DELETE.includes(user.role)) {
          throw new HttpError(403, 'Only an owner or a manager can delete an appointment.');
        }
        // Its copy in the stylist's Google Calendar goes first: the record
        // of which event it became is deleted along with it.
        await removeGoogleCopies(appt, appt.service_name);
        await client.query('DELETE FROM appointments WHERE id = $1', [appt.id]);
        return { appt, deleted: true };
      }

      default:
        throw new HttpError(400, `"${action}" is not something you can do to an appointment.`);
    }
  });

  if (result.cancelled && result.appt.guest_email) {
    try {
      await sendCancellation(result.appt, tenant);
    } catch (err) {
      console.error('cancellation email failed for', ref, err);
    }
  }

  // The follow-ups this action starts or stops (M5 to M8). After the
  // transaction, never inside it: a queued email is not worth rolling a
  // status change back for, and scheduled.js swallows its own failures.
  await followUps(action, result.appt, tenant);

  // Inline, for every action, so the stylist's Google copy matches by the
  // time the diary reloads; the daily cron puts right anything that fails.
  await mirrorToGoogle().catch((err) => console.error('google mirror deferred for', ref, err));

  return result;
}

/**
 * The price typed on the ticket (asked for 2026-11-14: "manually edit the
 * price here"). What a stylist entered in their settings is what a visit is
 * booked at; the desk can now say what it actually came to.
 *
 * An itemized visit (031) takes one price per service, `prices`, in cents,
 * in the ticket's order; the total is their sum, and, as when a visit is
 * booked (combineServices), it is priced only when every service is: some
 * typed and some left empty is refused rather than a total that quietly
 * counts the empty ones as nothing. All empty clears the price. A visit
 * booked before itemizing takes only its `total`, since how that split
 * between its services was never recorded.
 *
 * The price is what Home, Finance and Payroll count, so it is kept to the
 * people who see the salon's money (owner, admin, manager, the agency
 * login), and every change is written on the client's Admin activity with
 * who made it. Clients are never shown it (CLIENT_PRICES), so nothing is
 * sent.
 */
const MAX_CENTS = 10_000_00;
function readCents(v, what) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > MAX_CENTS) {
    throw new HttpError(400, `${what} must be an amount from $0 to $${(MAX_CENTS / 100).toLocaleString('en-US')}.`);
  }
  return n;
}
const dollars = (c) => (c == null ? 'not priced' : `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`);

export async function setVisitPrice(tenant, user, ref, body) {
  if (!CAN_DELETE.includes(user.role) && !canManageTeam(user)) {
    throw new HttpError(403, 'Only an owner, an admin or a manager can change a price.');
  }
  await transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT a.id, a.contact_id, a.price_cents, ${visitLinesSql()} AS lines, ${visitNameSql()} AS service_name
         FROM appointments a JOIN services v ON v.id = a.service_id
        WHERE a.ref = $1::text AND a.tenant_id = $2::uuid
        FOR NO KEY UPDATE OF a`,
      [ref, tenant.id],
    );
    const appt = rows[0];
    if (!appt) throw new HttpError(404, 'No appointment with that reference.');
    const saved = Array.isArray(appt.lines) && appt.lines.length ? appt.lines : null;
    const name = (l) => String(l?.name || 'Service');

    let total;
    let before;
    let after;
    if (saved) {
      if (!Array.isArray(body.prices) || body.prices.length !== saved.length) {
        throw new HttpError(400, 'Give a price for each service on the visit.');
      }
      const cents = body.prices.map((v, i) => readCents(v, `The price of ${name(saved[i])}`));
      const typed = cents.filter((c) => c != null);
      if (typed.length && typed.length !== cents.length) {
        throw new HttpError(400, 'Give every service a price, or leave them all empty.');
      }
      total = typed.length ? typed.reduce((a, b) => a + b, 0) : null;
      const lines = saved.map((l, i) => ({ ...l, priceCents: cents[i] }));
      await client.query(
        'UPDATE appointments SET services = $2::jsonb, price_cents = $3::int, updated_at = now() WHERE id = $1',
        [appt.id, JSON.stringify(lines), total],
      );
      const say = (ls) => ls.map((l) => `${name(l)} ${dollars(Number.isFinite(l?.priceCents) ? l.priceCents : null)}`).join(', ');
      before = say(saved);
      after = say(lines);
    } else {
      total = readCents(body.total, 'The total');
      await client.query(
        'UPDATE appointments SET price_cents = $2::int, updated_at = now() WHERE id = $1',
        [appt.id, total],
      );
      before = `${appt.service_name} ${dollars(appt.price_cents)}`;
      after = `${appt.service_name} ${dollars(total)}`;
    }
    if (appt.contact_id && before !== after) {
      await logChanges(client.query.bind(client), tenant.id, appt.contact_id, user,
        [{ field: 'visit_price', old: before, new: after }]);
    }
  });
  return ticketFor(tenant, ref);
}

/**
 * Move a booking to a new time, and to another stylist if it was dropped in
 * their column (Appt. Book's drag and drop, 2026-11-02).
 *
 * The desk's rules, as for a desk booking or a team member moving one by
 * text with Karen (karen-sms.js moveIt): any time from now that is free in
 * the stylist's working hours, inside the salon's opening hours, not limited
 * by Google. The time is checked through availableSlots like every other
 * path that books or moves a visit, so a drag cannot land a client outside
 * the hours, over another booking or in somebody's lunch; the no-overlap
 * constraint has the last word if two people move at once.
 *
 * The visit keeps its own length, breaks, services and price. The client
 * gets the usual "your appointment has moved" email (and text, when they
 * agreed to texts), and the stylist's Google copy follows at once.
 */
const MOVABLE_SQL = `SELECT a.*, s.name AS stylist_name, s.slug AS stylist_slug,
              ${visitNameSql()} AS service_name, ${visitLinesSql()} AS lines, v.slug AS service_slug
         FROM appointments a
         JOIN stylists s ON s.id = a.stylist_id
         JOIN services v ON v.id = a.service_id
        WHERE a.ref = $1::text AND a.tenant_id = $2::uuid`;

/** Only a booking still on the books moves; one that happened or was called off stays. */
function assertMovable(current) {
  if (!current) throw new HttpError(404, 'No appointment with that reference.');
  if (current.status !== 'booked') {
    throw new HttpError(409, current.status === 'cancelled'
      ? 'That appointment is cancelled. Reopen it before moving it.'
      : 'That visit has already happened, so it stays where it was.');
  }
}

/**
 * The times this visit could move to on one day, with one stylist (its own
 * unless another is named): its own length and breaks, the desk's rules.
 * The same question moveAppointment asks, so the Move window offers
 * nothing the move would refuse.
 */
async function moveSlots(client, tenant, current, date, slug) {
  try {
    return await availableSlots(client, tenant, {
      serviceSlug: current.service_slug,
      stylistSlug: slug || current.stylist_slug,
      fromDate: date,
      toDate: date,
      excludeAppointmentId: current.id,
      minLeadMin: 0,
      length: { durationMin: current.duration_min, bufferMin: current.buffer_min, breaks: current.breaks },
    });
  } catch (err) {
    // The stylist asked for does not do this service, for instance.
    if (err.status === 404) throw new HttpError(409, err.message);
    throw err;
  }
}

/**
 * Change the services on a booked visit from its ticket (2026-11-16, ClickUp
 * 1k58pwrcvmy item 2: "not able to change a service or add a service onto a
 * ticket"; and item 4's "adding it to the ticket later does not close off the
 * time needed").
 *
 * The visit is worked out again exactly as a new booking with these services
 * would be (availableSlots: the stylist's own minutes, color's Start, Break
 * and Finish, every service end to end), with the same stylist at the same
 * start, and has to fit there: their hours, other bookings, blocks and the
 * lunch, by the desk's rules. So a longer visit really holds the extra time
 * on the book, and one that would run into the next client is refused with
 * nothing changed. The no-overlap constraint has the last word.
 *
 * A visit already under way (checked in, its start passed) cannot be asked
 * of availableSlots, which offers nothing earlier than now. Then only what
 * is added after now has to be free: the visit's span from now on must miss
 * blocks and closures and finish inside the stylist's shift, and the
 * constraint guards the other bookings.
 *
 * Prices: a service that stays keeps the price on the ticket (typed by the
 * desk, or as booked); a new one takes its stylist's price; the visit is
 * priced only when every service is, as at booking. Nothing is sent to the
 * client, as with a price change; the stylist's Google copy follows.
 */
const MAX_VISIT_SERVICES = 6;   // availableSlots takes the first and five more

export async function setVisitServices(tenant, user, ref, body) {
  const slugs = Array.isArray(body.services)
    ? [...new Set(body.services.map((x) => String(x || '').trim()).filter(Boolean))] : [];
  if (!slugs.length) {
    throw new HttpError(400, 'Keep at least one service on the visit. To call it off, cancel the appointment.');
  }
  if (slugs.length > MAX_VISIT_SERVICES) {
    throw new HttpError(400, `A visit can have up to ${MAX_VISIT_SERVICES} services.`);
  }

  const result = await transaction(async (client) => {
    const current = (await client.query(`${MOVABLE_SQL} FOR NO KEY UPDATE OF a`, [ref, tenant.id])).rows[0];
    if (!current) throw new HttpError(404, 'No appointment with that reference.');
    if (current.status !== 'booked') {
      throw new HttpError(409, current.status === 'cancelled'
        ? 'That appointment is cancelled. Reopen it before changing its services.'
        : 'That visit is closed, so its services stay as they were.');
    }
    const saved = Array.isArray(current.lines) && current.lines.length ? current.lines : null;
    const before = (saved || [{ slug: current.service_slug, name: current.service_name }]);
    if (before.map((l) => l.slug).join(',') === slugs.join(',')) return { changed: false };

    const startsAt = DateTime.fromJSDate(new Date(current.starts_at)).setZone(tenant.timezone);
    const started = startsAt <= DateTime.now();
    let found;
    try {
      found = await availableSlots(client, tenant, {
        serviceSlug: slugs[0],
        extraServiceSlugs: slugs.slice(1),
        stylistSlug: current.stylist_slug,
        // Under way: today only gives the visit's length; the fit is below.
        fromDate: started ? DateTime.now().setZone(tenant.timezone).toISODate() : startsAt.toISODate(),
        toDate: started ? DateTime.now().setZone(tenant.timezone).toISODate() : startsAt.toISODate(),
        excludeAppointmentId: current.id,
        minLeadMin: 0,
      });
    } catch (err) {
      // A service that is off, or one this stylist does not do.
      if (err.status === 404) {
        throw new HttpError(409, err.message === 'That stylist does not offer this service.'
          || err.message === 'That stylist does not offer all of these services.'
          ? `${current.stylist_name} does not do ${slugs.length > 1 ? 'all of these services' : 'that service'}.`
          : err.message);
      }
      throw err;
    }
    const visit = found.visits.get(current.stylist_id);
    if (!visit) throw new HttpError(409, `${current.stylist_name} does not do all of these services.`);
    const endsAt = startsAt.plus({ minutes: visit.durationMin });
    const tooLong = `${current.stylist_name} is not free for that. With these services the visit would run to ${endsAt.toFormat('h:mm a')}, into another booking, a block or past their hours.`;

    if (!started) {
      const fits = found.days.flatMap((d) => d.slots)
        .some((x) => DateTime.fromISO(x.start).toMillis() === startsAt.toMillis() && x.stylistIds.includes(current.stylist_id));
      if (!fits) throw new HttpError(409, tooLong);
    } else if (visit.durationMin > current.duration_min) {
      // Only the time added has to be free: from where the visit ended
      // (or now, if later) to its new end, inside the stylist's shift that
      // day and clear of blocks. Other bookings are the constraint's.
      const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
      const { rows: shifts } = await client.query(
        'SELECT starts_at, ends_at FROM stylist_hours WHERE stylist_id = $1::uuid AND weekday = $2::int',
        [current.stylist_id, startsAt.weekday % 7],
      );
      const startMin = startsAt.hour * 60 + startsAt.minute;
      const endMin = startMin + visit.durationMin;
      if (!shifts.some((sh) => mins(sh.starts_at) <= startMin && endMin <= mins(sh.ends_at))) {
        throw new HttpError(409, tooLong);
      }
      const oldEnd = startsAt.plus({ minutes: current.duration_min });
      const { rows: off } = await client.query(
        `SELECT 1 FROM time_off
          WHERE tenant_id = $1::uuid AND (stylist_id = $2::uuid OR stylist_id IS NULL)
            AND during && tstzrange(least(greatest(now(), $3::timestamptz), $4::timestamptz), $4::timestamptz, '[)')
          LIMIT 1`,
        [tenant.id, current.stylist_id, oldEnd.toISO(), endsAt.toISO()],
      );
      if (off.length) throw new HttpError(409, tooLong);
    }

    // What the ticket already says a staying service costs wins over the
    // stylist's figure: the desk may have typed it.
    const kept = new Map((saved || []).map((l) => [l.slug, l.priceCents ?? null]));
    const lines = visit.lines.map((l) => (kept.has(l.slug) ? { ...l, priceCents: kept.get(l.slug) } : l));
    const priced = lines.every((l) => Number.isFinite(l.priceCents));
    const total = priced ? lines.reduce((t, l) => t + l.priceCents, 0) : null;
    const ids = new Map([found.service, ...found.extras].map((v) => [v.slug, v.id]));

    try {
      await client.query(
        `UPDATE appointments
            SET service_id = $2::uuid, duration_min = $3::int, buffer_min = $4::int,
                price_cents = $5::int, breaks = $6::jsonb,
                during = tstzrange(starts_at, starts_at + make_interval(mins => $3::int + $4::int), '[)'),
                updated_at = now()
          WHERE id = $1::uuid AND status = 'booked'`,
        [current.id, ids.get(lines[0].slug), visit.durationMin, visit.bufferMin || 0, total,
          JSON.stringify(visit.breaks || [])],
      );
    } catch (err) {
      if (err.code === EXCLUSION_VIOLATION) throw new HttpError(409, tooLong);
      throw err;
    }
    if (await hasColumn('appointments', 'services', client)) {
      await client.query('UPDATE appointments SET services = $2::jsonb WHERE id = $1::uuid',
        [current.id, JSON.stringify(lines)]);
    }
    if (current.contact_id) {
      const say = (ls) => ls.map((l) => l.name).join(' + ');
      await logChanges(client.query.bind(client), tenant.id, current.contact_id, user,
        [{ field: 'visit_services', old: say(before), new: say(lines) }]);
    }
    return { changed: true, id: current.id };
  });

  if (result.changed) {
    await mirrorToGoogle({ appointmentId: result.id }).catch((err) => console.error('google mirror deferred for', ref, err));
  }
  return ticketFor(tenant, ref);
}

/** GET ?ref=&times=YYYY-MM-DD[&stylist=]: where the Move window can put it. */
export async function moveTimes(tenant, ref, date, slug) {
  return transaction(async (client) => {
    const current = (await client.query(MOVABLE_SQL, [ref, tenant.id])).rows[0];
    assertMovable(current);
    const { days } = await moveSlots(client, tenant, current, date, slug);
    return days.flatMap((d) => d.slots).map((x) => x.start);
  });
}

export async function moveAppointment(tenant, user, ref, { start, stylist, notify = true }) {
  const requested = DateTime.fromISO(requireString(start, 'New time', { max: 40 }), { setZone: true });
  if (!requested.isValid) throw new HttpError(400, 'That time is not valid.');
  const startsAt = requested.setZone(tenant.timezone);
  const toSlug = stylist ? requireString(stylist, 'Stylist', { max: 80 }) : null;

  const { appt, previousStart, moved } = await transaction(async (client) => {
    const current = (await client.query(`${MOVABLE_SQL} FOR NO KEY UPDATE OF a`, [ref, tenant.id])).rows[0];
    // A booking whose time has passed can still be moved on, to now or
    // later (the salon asked, 2026-11-02, that staff can always move a
    // booked visit): availableSlots offers nothing earlier than now.
    assertMovable(current);
    const targetSlug = toSlug || current.stylist_slug;
    const same = targetSlug === current.stylist_slug
      && startsAt.toMillis() === DateTime.fromJSDate(new Date(current.starts_at)).toMillis();
    if (same) return { appt: current, previousStart: current.starts_at, moved: false };

    const found = await moveSlots(client, tenant, current, startsAt.toISODate(), targetSlug);
    const slot = found.days.flatMap((d) => d.slots)
      .find((x) => DateTime.fromISO(x.start).toMillis() === startsAt.toMillis());
    if (!slot) {
      throw new HttpError(409, `${startsAt.toFormat('h:mm a')} is not free for this visit. It may run past their hours or into another booking.`);
    }
    const stylistId = slot.stylistIds[0];
    const to = found.stylists.find((x) => x.id === stylistId);
    try {
      const { rows: up } = await client.query(
        `UPDATE appointments
            SET starts_at = $2::timestamptz, stylist_id = $3::uuid,
                during = tstzrange($2::timestamptz,
                                   $2::timestamptz + make_interval(mins => duration_min + buffer_min), '[)'),
                updated_at = now()
          WHERE id = $1::uuid AND status = 'booked'
          RETURNING *`,
        [current.id, startsAt.toISO(), stylistId],
      );
      return {
        appt: {
          ...up[0],
          stylist_name: to?.name ?? current.stylist_name,
          stylist_slug: to?.slug ?? current.stylist_slug,
          service_name: current.service_name,
          service_slug: current.service_slug,
          lines: current.lines,
        },
        previousStart: current.starts_at,
        moved: true,
      };
    } catch (err) {
      if (err.code === EXCLUSION_VIOLATION) {
        throw new HttpError(409, 'That time has just been taken. Pick another.');
      }
      throw err;
    }
  });

  if (moved) {
    // The client hears about it only when the person moving it chose
    // "Send the Client a Notification" (asked for 2026-11-02);
    // "Just Move the Appointment" changes the schedule quietly. The stylist's
    // Google copy follows either way: that is their diary, not a message.
    if (notify) {
      try {
        await sendReschedule(appt, previousStart, tenant);
      } catch (err) {
        console.error('reschedule email failed for', ref, err);
      }
    }
    await mirrorToGoogle({ appointmentId: appt.id }).catch((err) => console.error('google mirror deferred for', ref, err));
  }
  return { appt, moved };
}

/**
 * Anyone but the owner reaches only appointments in their own chair (asked
 * for 2026-11-03, scope.js), and moves them only within it. Anything else
 * reads as not found, which is all it is to them.
 */
export async function assertMyAppointment(user, tenant, ref, { toStylist = null } = {}) {
  const chair = await chairOf(user);
  if (!chair) return;
  const { rows } = await query(
    'SELECT stylist_id FROM appointments WHERE tenant_id = $1::uuid AND ref = $2::text',
    [tenant.id, ref],
  );
  if (!rows[0] || !inChair(chair, rows[0].stylist_id)) throw new HttpError(404, 'No appointment with that reference.');
  if (toStylist && !chair.slugs.includes(toStylist)) throw new HttpError(403, 'You can only move it within your own chair.');
}

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);
    const url = new URL(req.url, 'http://localhost');
    const ref = requireString(url.searchParams.get('ref'), 'Reference', { max: 16 }).toUpperCase();
    await assertMyAppointment(user, tenant, ref, { toStylist: url.searchParams.get('stylist') || null });
    if (url.searchParams.has('times')) {
      const date = requireDate(url.searchParams.get('times'), 'Date');
      const slug = url.searchParams.get('stylist') || null;
      return json(res, 200, { ref, date, times: await moveTimes(tenant, ref, date, slug) });
    }
    const ticket = await ticketFor(tenant, ref);
    if (!ticket) throw new HttpError(404, 'No appointment with that reference.');
    return json(res, 200, ticket);
  },

  async POST(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);
    const body = await readJson(req);

    const ref = requireString(body.ref, 'Reference', { max: 16 }).toUpperCase();
    const action = requireString(body.action, 'Action', { max: 20 });
    await assertMyAppointment(user, tenant, ref, { toStylist: action === 'move' ? body.stylist || null : null });
    if (action === 'price') return json(res, 200, await setVisitPrice(tenant, user, ref, body));
    if (action === 'services') return json(res, 200, await setVisitServices(tenant, user, ref, body));
    if (action === 'move') {
      // Notifying is the default; only an explicit false keeps it quiet.
      const notify = body.notify !== false;
      const { appt, moved } = await moveAppointment(tenant, user, ref, { start: body.start, stylist: body.stylist, notify });
      return json(res, 200, {
        ref, action, moved, notified: moved && notify, startsAt: appt.starts_at, stylistSlug: appt.stylist_slug, stylist: appt.stylist_name,
      });
    }
    const result = await applyAppointmentAction(tenant, user, ref, action);

    if (result.deleted) {
      return json(res, 200, { ref, action, deleted: true });
    }

    return json(res, 200, {
      ref,
      action,
      status: result.appt.status,
      checkedInAt: result.appt.checked_in_at,
    });
  },
});

/**
 * What each status change sets in motion, and what it calls off.
 *
 * Kept here rather than inside the transaction because none of it is worth
 * failing the status change for: an email that is not queued is a missed
 * follow-up, an aborted transaction is a diary that disagrees with itself.
 */
async function followUps(action, appt, tenant) {
  const who = {
    tenantId: tenant.id,
    appointmentId: appt.id,
    contactId: appt.contact_id || null,
    toName: appt.guest_name,
    toEmail: appt.guest_email,
  };
  if (!appt.guest_email) return;

  if (action === 'no_show') {
    // M5. An hour, then three days: long enough not to read as automated,
    // soon enough that the visit is still in mind.
    await enqueue('no_show_1', { ...who, sendAfter: at({ hours: 1 }) });
    await enqueue('no_show_2', { ...who, sendAfter: at({ days: 3 }) });
    return;
  }

  if (action === 'complete') {
    // M7 and M8. The review ask goes last, so a guest who was unhappy has
    // already had somewhere to say so.
    await enqueue('post_visit', { ...who, sendAfter: at({ hours: 3 }) });
    await enqueue('aftercare', { ...who, sendAfter: at({ days: 1 }) });
    await enqueue('review_ask', { ...who, sendAfter: at({ days: 2 }) });
    return;
  }

  if (action === 'cancel') {
    // M6, but only when it is late enough to matter. Earlier than that the
    // ordinary cancellation email has already said everything.
    const hoursAhead = (new Date(appt.starts_at) - Date.now()) / 3600000;
    if (hoursAhead < 24) {
      await enqueue('late_cancel', { ...who, sendAfter: at({ hours: 1 }) });
    }
    // Nothing else queued about this booking still makes sense.
    await cancelFor({ appointmentId: appt.id }, 'appointment cancelled',
      ['welcome_new', 'post_visit', 'aftercare', 'review_ask']);
    return;
  }

  if (action === 'reopen') {
    await cancelFor({ appointmentId: appt.id }, 'appointment reopened', ['late_cancel']);
  }
}
