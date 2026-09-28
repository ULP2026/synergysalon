/**
 * POST /api/book — take an appointment.
 *
 * The slot is re-checked here rather than trusted from the browser, and the
 * insert itself is the real guard: the database refuses a range that overlaps
 * one this stylist already has, so the loser of a race gets a clean 409
 * instead of a double booking.
 */
import { DateTime } from 'luxon';

import { availableSlots, chooseStylist } from './_lib/availability.js';
import { EXCLUSION_VIOLATION, UNIQUE_VIOLATION, transaction } from './_lib/db.js';
import { sendConfirmation } from './_lib/email.js';
import {
  HttpError, handler, json, newRef, newToken,
  optionalPhone, readJson, requireEmail, requireId, requireString,
} from './_lib/http.js';
import { SALON_TZ } from './_lib/config.js';

const SLOT_TAKEN = 'SLOT_TAKEN';

export default handler({
  async POST(req, res) {
    const body = await readJson(req);

    const serviceId = requireId(body.service, 'Service');
    const requestedStylist = body.stylist && body.stylist !== 'any'
      ? requireId(body.stylist, 'Stylist')
      : null;
    const guestName = requireString(body.name, 'Name', { max: 120 });
    const guestEmail = requireEmail(body.email);
    const guestPhone = optionalPhone(body.phone);
    const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 1000) : '';

    const start = DateTime.fromISO(requireString(body.start, 'Appointment time', { max: 40 }), {
      setZone: true,
    });
    if (!start.isValid) throw new HttpError(400, 'That appointment time is not valid.');
    const startsAt = start.setZone(SALON_TZ);

    const appointment = await transaction(async (client) => {
      // Re-derive what is genuinely free. The browser's copy may be minutes
      // old, and a guest who sat on the confirm button should be told so.
      const { service, days } = await availableSlots(client, {
        serviceId,
        stylistId: requestedStylist,
        fromDate: startsAt.toISODate(),
        toDate: startsAt.toISODate(),
      });

      const wanted = startsAt.toMillis();
      const slot = days
        .flatMap((d) => d.slots)
        .find((s) => DateTime.fromISO(s.start).toMillis() === wanted);

      if (!slot) {
        throw new HttpError(409, 'That time has just been taken. Please pick another.', SLOT_TAKEN);
      }

      // Try the preferred stylist first, then the rest, so a race on one
      // person does not fail a booking the salon could still honour.
      const preferred = requestedStylist ?? await chooseStylist(client, slot.stylists);
      const order = [preferred, ...slot.stylists.filter((id) => id !== preferred)];

      for (const stylistId of order) {
        const attempt = await insertAppointment(client, {
          stylistId, service, startsAt, guestName, guestEmail, guestPhone, notes,
        });
        if (attempt) return attempt;
        // Someone took this stylist mid-request; fall through to the next.
      }

      throw new HttpError(409, 'That time has just been taken. Please pick another.', SLOT_TAKEN);
    });

    // The appointment exists. Email is a courtesy on top of it, never a
    // reason to tell the guest the booking failed.
    try {
      await sendConfirmation(appointment);
    } catch (err) {
      console.error('confirmation email failed for', appointment.ref, err);
    }

    return json(res, 201, {
      ref: appointment.ref,
      manageToken: appointment.manage_token,
      startsAt: appointment.starts_at,
      service: appointment.service_name,
      stylist: appointment.stylist_name,
      durationMin: appointment.duration_min,
    });
  },
});

/**
 * Insert one appointment, returning null if this stylist turned out to be
 * busy. A savepoint keeps the outer transaction usable after the constraint
 * fires, so the caller can try the next stylist.
 */
async function insertAppointment(client, opts) {
  const { stylistId, service, startsAt, guestName, guestEmail, guestPhone, notes } = opts;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await client.query('SAVEPOINT try_slot');
    try {
      const { rows } = await client.query(
        `INSERT INTO appointments (
           ref, stylist_id, service_id, starts_at, duration_min, buffer_min, price_cents,
           during, guest_name, guest_email, guest_phone, notes, manage_token
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           tstzrange($4, $4 + make_interval(mins => $5 + $6), '[)'),
           $8, $9, $10, $11, $12
         )
         RETURNING id, ref, starts_at, duration_min, price_cents, guest_name,
                   guest_email, manage_token`,
        [
          newRef(), stylistId, service.id, startsAt.toISO(),
          service.duration_min, service.buffer_min, service.price_cents,
          guestName, guestEmail, guestPhone, notes, newToken(),
        ],
      );
      await client.query('RELEASE SAVEPOINT try_slot');

      const { rows: named } = await client.query(
        `SELECT s.name AS stylist_name, v.name AS service_name
           FROM stylists s, services v WHERE s.id = $1 AND v.id = $2`,
        [stylistId, service.id],
      );
      return { ...rows[0], ...named[0] };
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT try_slot');
      // The slot is genuinely gone for this stylist.
      if (err.code === EXCLUSION_VIOLATION) return null;
      // A ref or token collided: astronomically unlikely, trivially retried.
      if (err.code === UNIQUE_VIOLATION) continue;
      throw err;
    }
  }
  throw new HttpError(500, 'Could not allocate a booking reference. Please try again.');
}
