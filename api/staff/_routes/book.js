/**
 * POST /api/staff/book — the front desk booking somebody in.
 *
 * Goes through the same createBooking as the public page. One path, so the
 * two cannot drift and the exclusion constraint protects both equally.
 *
 * Two things differ from a guest booking. An email address is optional,
 * because somebody standing at the desk may only leave a phone number. And
 * the minimum lead time is dropped: a guest should not book online for ten
 * minutes' time, but a member of staff looking at the person in front of them
 * absolutely can.
 */
import { assertSameOrigin, requireStaff } from '../../_lib/auth.js';
import { createBooking } from '../../_lib/booking.js';
import { query, transaction } from '../../_lib/db.js';
import { sendConfirmation } from '../../_lib/email.js';
import { mirrorToGoogle } from '../../_lib/google-mirror.js';
import { at, enqueue } from '../../_lib/scheduled.js';
import {
  HttpError, handler, json, optionalPhone, readJson, requireId, requireString,
} from '../../_lib/http.js';
import { tenantForUser } from '../../_lib/tenant.js';

export default handler({
  async POST(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);
    const body = await readJson(req);

    const contactId = typeof body.contact === 'string' && body.contact ? body.contact : null;

    const appointment = await transaction(async (client) => {
      let guestName = typeof body.name === 'string' ? body.name.trim() : '';
      let guestEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      let guestPhone = optionalPhone(body.phone);

      // Booking from a contact card: take their details rather than making
      // the front desk retype them, and mistype them.
      if (contactId) {
        const { rows } = await client.query(
          'SELECT name, email, phone FROM contacts WHERE id = $1 AND tenant_id = $2',
          [contactId, tenant.id],
        );
        if (!rows[0]) throw new HttpError(404, 'That contact no longer exists.');
        guestName = guestName || rows[0].name;
        guestEmail = guestEmail || rows[0].email;
        guestPhone = guestPhone || rows[0].phone;
      }

      if (!guestName) throw new HttpError(400, 'Who is the appointment for?');
      if (!guestEmail && !guestPhone) {
        throw new HttpError(400, 'An email address or a phone number is needed.');
      }

      const booked = await createBooking(client, tenant, {
        serviceSlug: requireId(body.service, 'Service'),
        stylistSlug: body.stylist && body.stylist !== 'any'
          ? requireId(body.stylist, 'Stylist')
          : null,
        start: requireString(body.start, 'Appointment time', { max: 40 }),
        guestName,
        guestEmail,
        guestPhone,
        notes: typeof body.notes === 'string' ? body.notes.trim().slice(0, 1000) : '',
        channel: 'staff',
        bookedBy: user.id,
        contactId,
        minLeadMin: 0,
      });

      return booked;
    });

    // Only if we have somewhere to send it. A phone-only booking is normal at
    // a front desk and must not be treated as a failure.
    if (appointment.guest_email) {
      try {
        await sendConfirmation(appointment, tenant);
      } catch (err) {
        console.error('confirmation email failed for', appointment.ref, err);
      }
    }

    await queueWelcome(appointment, tenant);

    // Onto the stylist's Google Calendar now rather than at the daily cron,
    // which puts right anything that fails here.
    await mirrorToGoogle().catch((err) => console.error('google mirror deferred for', appointment.ref, err));

    return json(res, 201, {
      ref: appointment.ref,
      startsAt: appointment.starts_at,
      service: appointment.service_name,
      stylist: appointment.stylist_name,
      durationMin: appointment.duration_min,
      guestName: appointment.guest_name,
    });
  },
});

/**
 * Queue the new guest welcome, if this really is their first booking.
 *
 * Asked of the database rather than the request: the contact row is the only
 * thing that knows whether this person has been here before, and two bookings
 * for the same new guest (one online, one at the desk) must not both count as
 * the first. The unique index on the queue would catch the duplicate anyway;
 * this keeps the second one from ever being written.
 */
async function queueWelcome(appointment, tenant) {
  if (!appointment.guest_email || !appointment.contact_id) return;
  try {
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM appointments
        WHERE contact_id = $1 AND id <> $2 AND status <> 'cancelled'`,
      [appointment.contact_id, appointment.id],
    );
    if (rows[0].n > 0) return;
    await enqueue('welcome_new', {
      tenantId: tenant.id,
      appointmentId: appointment.id,
      contactId: appointment.contact_id,
      toName: appointment.guest_name,
      toEmail: appointment.guest_email,
      // Far enough behind the confirmation that the two do not land together
      // and read as one message sent twice.
      sendAfter: at({ hours: 1 }),
    });
  } catch (err) {
    console.warn('welcome not queued for', appointment.ref, err.message);
  }
}
