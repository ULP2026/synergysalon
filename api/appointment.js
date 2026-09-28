/**
 * /api/appointment?ref=…&t=… — what a guest can do with their own booking.
 *
 *   GET     look it up
 *   PATCH   reschedule
 *   DELETE  cancel
 *
 * There are no accounts. The token from the confirmation email is the
 * credential, which is the right trade for a salon: an account nobody wants
 * to create is a booking nobody completes. The token is random, single
 * purpose, and useless once the appointment is cancelled.
 */
import { DateTime } from 'luxon';

import { SALON_TZ } from './_lib/config.js';
import { availableSlots } from './_lib/availability.js';
import { EXCLUSION_VIOLATION, transaction } from './_lib/db.js';
import { sendCancellation, sendReschedule } from './_lib/email.js';
import {
  HttpError, handler, json, readJson, requireId, requireString, tokenMatches,
} from './_lib/http.js';

const SLOT_TAKEN = 'SLOT_TAKEN';

/**
 * Find the appointment and prove the caller owns it.
 *
 * The lookup is by ref alone and the token compared afterwards in constant
 * time, so a wrong token and an unknown ref are indistinguishable from
 * outside — there is no way to discover which references exist.
 */
async function load(client, req, { forUpdate = false } = {}) {
  const url = new URL(req.url, 'http://localhost');
  const ref = requireString(url.searchParams.get('ref'), 'Reference', { max: 16 }).toUpperCase();
  const token = requireString(url.searchParams.get('t'), 'Token', { max: 64 });

  const { rows } = await client.query(
    `SELECT a.*, s.name AS stylist_name, v.name AS service_name, v.duration_min AS service_duration
       FROM appointments a
       JOIN stylists s ON s.id = a.stylist_id
       JOIN services v ON v.id = a.service_id
      WHERE a.ref = $1
      ${forUpdate ? 'FOR NO KEY UPDATE OF a' : ''}`,
    [ref],
  );

  const appt = rows[0];
  if (!appt || !tokenMatches(token, appt.manage_token)) {
    throw new HttpError(404, 'We could not find that appointment.');
  }
  return appt;
}

function present(appt) {
  return {
    ref: appt.ref,
    status: appt.status,
    service: appt.service_name,
    serviceId: appt.service_id,
    stylist: appt.stylist_name,
    stylistId: appt.stylist_id,
    startsAt: appt.starts_at,
    durationMin: appt.duration_min,
    price: appt.price_cents == null ? null : appt.price_cents / 100,
    guestName: appt.guest_name,
    guestEmail: appt.guest_email,
    notes: appt.notes,
  };
}

/** Past appointments are history: they can be read, but not moved or undone. */
function assertChangeable(appt) {
  if (appt.status === 'cancelled') {
    throw new HttpError(409, 'That appointment has already been cancelled.');
  }
  if (DateTime.fromJSDate(new Date(appt.starts_at)) <= DateTime.now()) {
    throw new HttpError(409, 'That appointment has already started. Please call the salon.');
  }
}

export default handler({
  async GET(req, res) {
    return transaction(async (client) => json(res, 200, present(await load(client, req))));
  },

  async PATCH(req, res) {
    const body = await readJson(req);
    const requested = DateTime.fromISO(
      requireString(body.start, 'New appointment time', { max: 40 }),
      { setZone: true },
    );
    if (!requested.isValid) throw new HttpError(400, 'That appointment time is not valid.');
    const startsAt = requested.setZone(SALON_TZ);
    const newStylist = body.stylist && body.stylist !== 'any'
      ? requireId(body.stylist, 'Stylist')
      : null;

    const { appt, previousStart } = await transaction(async (client) => {
      const current = await load(client, req, { forUpdate: true });
      assertChangeable(current);

      const stylistId = newStylist ?? current.stylist_id;

      // Ignore this booking when checking what is free, or a guest cannot
      // move their own appointment by fifteen minutes.
      const { days } = await availableSlots(client, {
        serviceId: current.service_id,
        stylistId,
        fromDate: startsAt.toISODate(),
        toDate: startsAt.toISODate(),
        excludeAppointmentId: current.id,
      });

      const wanted = startsAt.toMillis();
      const free = days.flatMap((d) => d.slots)
        .some((s) => DateTime.fromISO(s.start).toMillis() === wanted);
      if (!free) {
        throw new HttpError(409, 'That time is no longer free. Please pick another.', SLOT_TAKEN);
      }

      try {
        const { rows } = await client.query(
          `UPDATE appointments
              SET starts_at = $2,
                  stylist_id = $3,
                  during = tstzrange($2, $2 + make_interval(mins => duration_min + buffer_min), '[)'),
                  updated_at = now()
            WHERE id = $1
            RETURNING *`,
          [current.id, startsAt.toISO(), stylistId],
        );
        const { rows: named } = await client.query(
          `SELECT s.name AS stylist_name, v.name AS service_name
             FROM stylists s, services v WHERE s.id = $1 AND v.id = $2`,
          [stylistId, current.service_id],
        );
        return {
          appt: { ...rows[0], ...named[0] },
          previousStart: current.starts_at,
        };
      } catch (err) {
        if (err.code === EXCLUSION_VIOLATION) {
          throw new HttpError(409, 'That time has just been taken. Please pick another.', SLOT_TAKEN);
        }
        throw err;
      }
    });

    try {
      await sendReschedule(appt, previousStart);
    } catch (err) {
      console.error('reschedule email failed for', appt.ref, err);
    }
    return json(res, 200, present(appt));
  },

  async DELETE(req, res) {
    const appt = await transaction(async (client) => {
      const current = await load(client, req, { forUpdate: true });
      assertChangeable(current);
      const { rows } = await client.query(
        `UPDATE appointments
            SET status = 'cancelled', cancelled_at = now(), updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [current.id],
      );
      return { ...rows[0], stylist_name: current.stylist_name, service_name: current.service_name };
    });

    try {
      await sendCancellation(appt);
    } catch (err) {
      console.error('cancellation email failed for', appt.ref, err);
    }
    return json(res, 200, present(appt));
  },
});
