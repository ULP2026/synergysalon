/**
 * POST /api/staff/appointment: what the front desk does to a booking.
 * GET  ?ref=: the booking as a ticket -- the whole visit in one place.
 *
 *   check_in | undo_check_in | complete | no_show | cancel | reopen | delete
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

import { assertSameOrigin, requireStaff } from '../../_lib/auth.js';
import { EXCLUSION_VIOLATION, query, transaction } from '../../_lib/db.js';
import { mirrorToGoogle, removeGoogleCopies } from '../../_lib/google-mirror.js';
import { sendCancellation } from '../../_lib/email.js';
import { at, cancelFor, enqueue } from '../../_lib/scheduled.js';
import { HttpError, handler, json, readJson, requireString } from '../../_lib/http.js';
import { tenantForUser } from '../../_lib/tenant.js';

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
            a.cancelled_at, a.created_at, a.price_cents, a.notes, a.contact_id,
            a.guest_name, a.guest_email, a.guest_phone,
            to_jsonb(a) -> 'services' AS lines, to_jsonb(a) -> 'breaks' AS breaks,
            s.name AS stylist_name, s.slug AS stylist_slug,
            v.name AS service_name, v.slug AS service_slug,
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
  const saved = Array.isArray(r.lines) && r.lines.length ? r.lines : null;
  const lines = saved
    ? saved.map((l) => ({
      name: String(l.name || ''),
      priceCents: Number.isFinite(l.priceCents) ? l.priceCents : null,
      durationMin: Number.isFinite(l.durationMin) ? l.durationMin : null,
    }))
    : [{ name: r.service_name, priceCents: null, durationMin: null }];

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
    itemized: Boolean(saved),
    totalCents: r.price_cents,
    price: r.price_cents == null ? null : r.price_cents / 100,
    // No payment is recorded by this app yet (Stripe is not connected), so
    // there is nothing to say but that.
    payment: { status: 'not_tracked' },
    transactions: [],
  };
}

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);
    const url = new URL(req.url, 'http://localhost');
    const ref = requireString(url.searchParams.get('ref'), 'Reference', { max: 16 }).toUpperCase();
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

    const result = await transaction(async (client) => {
      const { rows } = await client.query(
        `SELECT a.*, s.name AS stylist_name, v.name AS service_name
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
