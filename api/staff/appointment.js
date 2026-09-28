/**
 * POST /api/staff/appointment — what the front desk does to a booking.
 *
 *   check_in | undo_check_in | complete | no_show | cancel | reopen
 *
 * Cancelling is the only action that gives the slot back. A completed or
 * no-show appointment still occupied the stylist's time, and letting the
 * diary re-sell it would rewrite history.
 */
import { assertSameOrigin, requireStaff } from '../_lib/auth.js';
import { enqueueSync } from '../_lib/booking.js';
import { EXCLUSION_VIOLATION, transaction } from '../_lib/db.js';
import { sendCancellation } from '../_lib/email.js';
import { HttpError, handler, json, readJson, requireString } from '../_lib/http.js';
import { tenantForUser } from '../_lib/tenant.js';

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

      switch (action) {
        case 'check_in':
          return { appt: await set('checked_in_at = COALESCE(checked_in_at, now())') };
        case 'undo_check_in':
          return { appt: await set('checked_in_at = NULL') };
        case 'complete':
          return { appt: await set("status = 'completed'") };
        case 'no_show':
          return { appt: await set("status = 'no_show'") };

        case 'cancel': {
          if (appt.status === 'cancelled') {
            throw new HttpError(409, 'That appointment is already cancelled.');
          }
          const updated = await set("status = 'cancelled', cancelled_at = now()");
          await enqueueSync(client, tenant.id, 'appointment.cancelled', { appointmentId: appt.id });
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
            await enqueueSync(client, tenant.id, 'appointment.booked', { appointmentId: appt.id });
            return { appt: updated };
          } catch (err) {
            if (err.code === EXCLUSION_VIOLATION) {
              throw new HttpError(409, 'That time has been taken by someone else since it was cancelled.');
            }
            throw err;
          }
        }

        default:
          throw new HttpError(400, `"${action}" is not something you can do to an appointment.`);
      }
    });

    if (result.cancelled && result.appt.guest_email) {
      try {
        await sendCancellation(result.appt, tenant.timezone);
      } catch (err) {
        console.error('cancellation email failed for', ref, err);
      }
    }

    return json(res, 200, {
      ref,
      action,
      status: result.appt.status,
      checkedInAt: result.appt.checked_in_at,
    });
  },
});
