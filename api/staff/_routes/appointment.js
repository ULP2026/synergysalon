/**
 * POST /api/staff/appointment: what the front desk does to a booking.
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
import { assertSameOrigin, requireStaff } from '../../_lib/auth.js';
import { EXCLUSION_VIOLATION, transaction } from '../../_lib/db.js';
import { mirrorToGoogle, removeGoogleCopies } from '../../_lib/google-mirror.js';
import { sendCancellation } from '../../_lib/email.js';
import { at, cancelFor, enqueue } from '../../_lib/scheduled.js';
import { HttpError, handler, json, readJson, requireString } from '../../_lib/http.js';
import { tenantForUser } from '../../_lib/tenant.js';

/** Same bar as deleting a contact: this removes history outright. */
const CAN_DELETE = ['owner', 'admin', 'manager'];

export default handler({
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
