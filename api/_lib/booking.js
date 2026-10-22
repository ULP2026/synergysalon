/**
 * Taking an appointment.
 *
 * One path, used by both the public booking page and the staff console. That
 * is deliberate: the moment there are two ways to write an appointment, they
 * drift, and the one that skipped a check is the one that double-books.
 */
import { DateTime } from 'luxon';

import { availableSlots, chooseStylist } from './availability.js';
import { EXCLUSION_VIOLATION, UNIQUE_VIOLATION, hasColumn } from './db.js';
import { HttpError, newRef, newToken } from './http.js';

export const SLOT_TAKEN = 'SLOT_TAKEN';

/**
 * Insert one appointment, returning null if this stylist turned out to be
 * busy. A savepoint keeps the outer transaction usable after the constraint
 * fires, so the caller can try the next stylist.
 */
async function insertFor(client, stylistId, ctx) {
  const {
    tenant, service, visits, startsAt, guestName, guestEmail, guestPhone, notes,
    channel, bookedBy, contactId,
  } = ctx;

  // How long it is depends on who does it (timing.js), so each stylist tried
  // is booked at their own length, with their own processing breaks.
  const visit = visits.get(stylistId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await client.query('SAVEPOINT try_slot');
    try {
      const { rows } = await client.query(
        `INSERT INTO appointments (
           tenant_id, ref, stylist_id, service_id, contact_id, starts_at,
           duration_min, buffer_min, price_cents, during,
           status, channel, booked_by,
           guest_name, guest_email, guest_phone, notes, manage_token, breaks
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9,
           tstzrange($6::timestamptz,
                     $6::timestamptz + make_interval(mins => $7::int + $8::int), '[)'),
           'booked', $10, $11,
           $12, $13, $14, $15, $16, $17::jsonb
         )
         RETURNING id, ref, starts_at, duration_min, price_cents,
                   guest_name, guest_email, guest_phone, manage_token, channel, breaks`,
        [
          // The visit's length and price: one service's own, or several
          // services end to end (combineServices in availability.js).
          tenant.id, newRef(), stylistId, service.id, contactId, startsAt.toISO(),
          visit.durationMin, visit.bufferMin, visit.priceCents,
          channel, bookedBy,
          guestName, guestEmail, guestPhone, notes, newToken(),
          // Where the stylist is free inside it: the constraint leaves these
          // out (appointment_blocks, migration 025).
          JSON.stringify(visit.breaks || []),
        ],
      );
      await client.query('RELEASE SAVEPOINT try_slot');

      // Every service of the visit, itemized, for its ticket (migration 031).
      // Asked first, so a database without the column books as it always has.
      if (visit.lines?.length && await hasColumn('appointments', 'services', client)) {
        await client.query('UPDATE appointments SET services = $2::jsonb WHERE id = $1::uuid',
          [rows[0].id, JSON.stringify(visit.lines)]);
      }

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
 * The guest's own client record, found or made, inside the booking's
 * transaction.
 *
 * Until now a booking only had one when the caller already knew it: the
 * website wizard, which creates the contact before it books, or the front
 * desk booking from somebody's card. A guest using the booking link, or a
 * name typed straight into New appointment, left contact_id null. Their name,
 * email and phone were on the appointment and the diary showed them
 * perfectly, so nothing looked broken -- but Clients reads the contacts
 * table, so the salon had no client, no history, and no second visit to
 * recognise. The welcome, rebook, second-visit and win-back emails all
 * select on contact_id, so none of them could ever fire for that person.
 *
 * Matched on either identifier, the same rule the Add client form uses: the
 * front desk often has only one, and somebody who rings twice must not
 * become two people. Oldest first, so a duplicate pair that already exists
 * keeps collecting history on the record it has been collecting it on.
 */
async function contactFor(client, tenant, { contactId, guestName, guestEmail, guestPhone, channel }) {
  if (contactId) return contactId;
  const email = String(guestEmail || '').trim().toLowerCase();
  const phone = String(guestPhone || '').trim();
  // A staff booking may have neither if it is a placeholder in the diary.
  if (!email && !phone) return null;

  const { rows: found } = await client.query(
    `SELECT id FROM contacts
      WHERE tenant_id = $1
        AND (($2 <> '' AND lower(email) = $2) OR ($3 <> '' AND phone = $3))
      ORDER BY created_at
      LIMIT 1`,
    [tenant.id, email, phone],
  );
  if (found[0]) return found[0].id;

  const { rows } = await client.query(
    `INSERT INTO contacts (tenant_id, name, email, phone, source, status)
     VALUES ($1, $2, $3, $4, $5, 'booked')
     RETURNING id`,
    [tenant.id, guestName, email, phone, channel === 'staff' ? 'Front desk' : 'Online booking'],
  );
  return rows[0].id;
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
  notes = '', channel = 'online', bookedBy = null, contactId = null, minLeadMin,
  extraServiceSlugs = [],
}) {
  const startsAt = DateTime.fromISO(start, { setZone: true }).setZone(tenant.timezone);
  if (!startsAt.isValid) throw new HttpError(400, 'That appointment time is not valid.');

  const { service, visits, days } = await availableSlots(client, tenant, {
    serviceSlug,
    stylistSlug,
    extraServiceSlugs,
    // A guest booking online is not offered time a connected stylist is
    // busy in Google; the desk, who can see the stylist, may book over it.
    google: channel === 'online',
    fromDate: startsAt.toISODate(),
    toDate: startsAt.toISODate(),
    minLeadMin,
    // The salon's own hours, for guests and staff alike.
    centro: false,   // our own hours, not a third party's
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

  // Whoever this is booked for is a client of the salon from here on,
  // however they booked.
  const contact = await contactFor(client, tenant, {
    contactId, guestName, guestEmail, guestPhone, channel,
  });

  const ctx = {
    tenant, service, visits, startsAt, guestName, guestEmail, guestPhone, notes,
    channel, bookedBy, contactId: contact,
  };

  for (const stylistId of order) {
    const booked = await insertFor(client, stylistId, ctx);
    if (booked) {
      if (contact) {
        // An enquiry who has now booked, and the date the salon first took
        // one from them. A won or lost contact keeps the status somebody
        // chose for them; booking again does not overrule a person.
        await client.query(
          `UPDATE contacts
              SET status = CASE WHEN status IN ('new', 'contacted')
                                THEN 'booked'::contact_status ELSE status END,
                  first_booked_at = COALESCE(first_booked_at, now()),
                  updated_at = now()
            WHERE id = $1 AND tenant_id = $2`,
          [contact, tenant.id],
        );
      }
      return { ...booked, contact_id: contact };
    }
    // Someone took this stylist mid-request; fall through to the next.
  }

  throw new HttpError(409, 'That time has just been taken. Please pick another.', SLOT_TAKEN);
}
