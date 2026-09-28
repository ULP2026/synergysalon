/**
 * Taking an appointment.
 *
 * One path, used by both the public booking page and the staff console. That
 * is deliberate: the moment there are two ways to write an appointment, they
 * drift, and the one that skipped a check is the one that double-books.
 */
import { DateTime } from 'luxon';

import { availableSlots, chooseStylist } from './availability.js';
import { EXCLUSION_VIOLATION, UNIQUE_VIOLATION } from './db.js';
import { HttpError, newRef, newToken } from './http.js';

export const SLOT_TAKEN = 'SLOT_TAKEN';

/**
 * Queue a push to CENTRO.
 *
 * Written in the same transaction as the appointment, sent afterwards by the
 * sync worker. If GoHighLevel is down or its token has expired, the salon
 * still has the booking and the push retries. Calling the CRM inline would
 * mean their outage turns guests away.
 */
export async function enqueueSync(client, tenantId, kind, { appointmentId = null, leadId = null, payload = {} } = {}) {
  await client.query(
    `INSERT INTO sync_outbox (tenant_id, kind, appointment_id, lead_id, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, kind, appointmentId, leadId, JSON.stringify(payload)],
  );
}

/**
 * Insert one appointment, returning null if this stylist turned out to be
 * busy. A savepoint keeps the outer transaction usable after the constraint
 * fires, so the caller can try the next stylist.
 */
async function insertFor(client, stylistId, ctx) {
  const {
    tenant, service, startsAt, guestName, guestEmail, guestPhone, notes,
    channel, bookedBy, leadId,
  } = ctx;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await client.query('SAVEPOINT try_slot');
    try {
      const { rows } = await client.query(
        `INSERT INTO appointments (
           tenant_id, ref, stylist_id, service_id, lead_id, starts_at,
           duration_min, buffer_min, price_cents, during,
           status, channel, booked_by,
           guest_name, guest_email, guest_phone, notes, manage_token
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9,
           tstzrange($6::timestamptz,
                     $6::timestamptz + make_interval(mins => $7::int + $8::int), '[)'),
           'booked', $10, $11,
           $12, $13, $14, $15, $16
         )
         RETURNING id, ref, starts_at, duration_min, price_cents,
                   guest_name, guest_email, guest_phone, manage_token, channel`,
        [
          tenant.id, newRef(), stylistId, service.id, leadId, startsAt.toISO(),
          service.duration_min, service.buffer_min, service.price_cents,
          channel, bookedBy,
          guestName, guestEmail, guestPhone, notes, newToken(),
        ],
      );
      await client.query('RELEASE SAVEPOINT try_slot');

      const { rows: named } = await client.query(
        `SELECT s.name AS stylist_name, s.slug AS stylist_slug,
                v.name AS service_name, v.slug AS service_slug
           FROM stylists s, services v WHERE s.id = $1 AND v.id = $2`,
        [stylistId, service.id],
      );
      return { ...rows[0], ...named[0], stylist_id: stylistId, service_id: service.id };
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

/**
 * Book an appointment inside an open transaction.
 *
 * Availability is re-derived here rather than trusted from the caller: the
 * browser's copy may be minutes old. That check still cannot be the guarantee,
 * though -- the exclusion constraint is, and this retries around it.
 */
export async function createBooking(client, tenant, {
  serviceSlug, stylistSlug, start, guestName, guestEmail = '', guestPhone = '',
  notes = '', channel = 'online', bookedBy = null, leadId = null, minLeadMin,
}) {
  const startsAt = DateTime.fromISO(start, { setZone: true }).setZone(tenant.timezone);
  if (!startsAt.isValid) throw new HttpError(400, 'That appointment time is not valid.');

  const { service, days } = await availableSlots(client, tenant, {
    serviceSlug,
    stylistSlug,
    fromDate: startsAt.toISODate(),
    toDate: startsAt.toISODate(),
    minLeadMin,
  });

  const wanted = startsAt.toMillis();
  const slot = days.flatMap((d) => d.slots)
    .find((s) => DateTime.fromISO(s.start).toMillis() === wanted);
  if (!slot) {
    throw new HttpError(409, 'That time is not available. Please pick another.', SLOT_TAKEN);
  }

  // Try the preferred stylist first, then the rest, so a race on one person
  // does not fail a booking the salon could still honour.
  const preferred = stylistSlug
    ? slot.stylistIds[0]
    : await chooseStylist(client, slot.stylistIds);
  const order = [preferred, ...slot.stylistIds.filter((id) => id !== preferred)];

  const ctx = {
    tenant, service, startsAt, guestName, guestEmail, guestPhone, notes,
    channel, bookedBy, leadId,
  };

  for (const stylistId of order) {
    const booked = await insertFor(client, stylistId, ctx);
    if (booked) {
      await enqueueSync(client, tenant.id, 'appointment.booked', {
        appointmentId: booked.id,
        leadId,
      });
      if (leadId) {
        await client.query(
          `UPDATE leads SET status = 'booked', updated_at = now()
            WHERE id = $1 AND tenant_id = $2 AND status IN ('new', 'contacted')`,
          [leadId, tenant.id],
        );
      }
      return booked;
    }
    // Someone took this stylist mid-request; fall through to the next.
  }

  throw new HttpError(409, 'That time has just been taken. Please pick another.', SLOT_TAKEN);
}
