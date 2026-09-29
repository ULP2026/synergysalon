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

import { availableSlots } from './_lib/availability.js';
import { enqueueSync } from './_lib/booking.js';
import { EXCLUSION_VIOLATION, transaction } from './_lib/db.js';
import { sendCancellation, sendReschedule } from './_lib/email.js';
import {
  HttpError, handler, json, readJson, requireId, requireString, tokenMatches,
} from './_lib/http.js';
import { tenantForRequest } from './_lib/tenant.js';

const SLOT_TAKEN = 'SLOT_TAKEN';

/**
 * Find the appointment and prove the caller owns it.
 *
 * The lookup is by reference alone and the token compared afterwards in
 * constant time, so a wrong token and an unknown reference are
 * indistinguishable from outside: there is no way to discover which
 * references exist.
 */
async function load(client, req, tenant, { forUpdate = false } = {}) {
  const url = new URL(req.url, 'http://localhost');
  const ref = requireString(url.searchParams.get('ref'), 'Reference', { max: 16 }).toUpperCase();
  const token = requireString(url.searchParams.get('t'), 'Token', { max: 64 });

  const { rows } = await client.query(
    `SELECT a.*, s.name AS stylist_name, s.slug AS stylist_slug,
            v.name AS service_name, v.slug AS service_slug
       FROM appointments a
       JOIN stylists s ON s.id = a.stylist_id
       JOIN services v ON v.id = a.service_id
      WHERE a.ref = $1 AND a.tenant_id = $2
      ${forUpdate ? 'FOR NO KEY UPDATE OF a' : ''}`,
    [ref, tenant.id],
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
    serviceSlug: appt.service_slug,
    stylist: appt.stylist_name,
    stylistSlug: appt.stylist_slug,
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
  if (new Date(appt.starts_at) <= new Date()) {
    throw new HttpError(409, 'That appointment has already started. Please call the salon.');
  }
}

export default handler({
  async GET(req, res) {
    const tenant = await tenantForRequest(req);
    return transaction(async (client) => json(res, 200, present(await load(client, req, tenant))));
  },

  async PATCH(req, res) {
    const tenant = await tenantForRequest(req);
    const body = await readJson(req);

    const requested = DateTime.fromISO(
      requireString(body.start, 'New appointment time', { max: 40 }),
      { setZone: true },
    );
    if (!requested.isValid) throw new HttpError(400, 'That appointment time is not valid.');
    const startsAt = requested.setZone(tenant.timezone);
    const newStylist = body.stylist && body.stylist !== 'any'
      ? requireId(body.stylist, 'Stylist')
      : null;

    const { appt, previousStart } = await transaction(async (client) => {
      const current = await load(client, req, tenant, { forUpdate: true });
      assertChangeable(current);

      // Ignore this booking when checking what is free, or a guest cannot
      // move their own appointment by fifteen minutes.
      const { days, stylists } = await availableSlots(client, tenant, {
        serviceSlug: current.service_slug,
        stylistSlug: newStylist ?? current.stylist_slug,
        fromDate: startsAt.toISODate(),
        toDate: startsAt.toISODate(),
        excludeAppointmentId: current.id,
        centro: true,
      });

      const wanted = startsAt.toMillis();
      const slot = days.flatMap((d) => d.slots)
        .find((s) => DateTime.fromISO(s.start).toMillis() === wanted);
      if (!slot) {
        throw new HttpError(409, 'That time is no longer free. Please pick another.', SLOT_TAKEN);
      }
      const stylistId = slot.stylistIds[0];

      try {
        const { rows } = await client.query(
          `UPDATE appointments
              SET starts_at = $2,
                  stylist_id = $3,
                  during = tstzrange($2::timestamptz,
                                     $2::timestamptz + make_interval(mins => duration_min + buffer_min), '[)'),
                  updated_at = now()
            WHERE id = $1
            RETURNING *`,
          [current.id, startsAt.toISO(), stylistId],
        );
        await enqueueSync(client, tenant.id, 'appointment.rescheduled', {
          appointmentId: current.id,
        });

        const stylist = stylists.find((s) => s.id === stylistId);
        return {
          appt: {
            ...rows[0],
            stylist_name: stylist?.name ?? current.stylist_name,
            stylist_slug: stylist?.slug ?? current.stylist_slug,
            service_name: current.service_name,
            service_slug: current.service_slug,
          },
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
      await sendReschedule(appt, previousStart, tenant.timezone);
    } catch (err) {
      console.error('reschedule email failed for', appt.ref, err);
    }
    return json(res, 200, present(appt));
  },

  async DELETE(req, res) {
    const tenant = await tenantForRequest(req);

    const appt = await transaction(async (client) => {
      const current = await load(client, req, tenant, { forUpdate: true });
      assertChangeable(current);
      const { rows } = await client.query(
        `UPDATE appointments
            SET status = 'cancelled', cancelled_at = now(), updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [current.id],
      );
      await enqueueSync(client, tenant.id, 'appointment.cancelled', {
        appointmentId: current.id,
      });
      return {
        ...rows[0],
        stylist_name: current.stylist_name,
        stylist_slug: current.stylist_slug,
        service_name: current.service_name,
        service_slug: current.service_slug,
      };
    });

    try {
      await sendCancellation(appt, tenant);
    } catch (err) {
      console.error('cancellation email failed for', appt.ref, err);
    }
    return json(res, 200, present(appt));
  },
});
