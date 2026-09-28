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
import { transaction } from '../../_lib/db.js';
import { sendConfirmation } from '../../_lib/email.js';
import {
  HttpError, handler, json, optionalPhone, readJson, requireId, requireString,
} from '../../_lib/http.js';
import { tenantForUser } from '../../_lib/tenant.js';
import { drain } from '../../cron/sync.js';

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

      if (contactId) {
        await client.query(
          `UPDATE contacts
              SET first_booked_at = COALESCE(first_booked_at, now()), updated_at = now()
            WHERE id = $1`,
          [contactId],
        );
      }
      return booked;
    });

    // Only if we have somewhere to send it. A phone-only booking is normal at
    // a front desk and must not be treated as a failure.
    if (appointment.guest_email) {
      try {
        await sendConfirmation(appointment, tenant.timezone);
      } catch (err) {
        console.error('confirmation email failed for', appointment.ref, err);
      }
    }

    try {
      await drain(1);
    } catch (err) {
      console.error('CENTRO sync deferred for', appointment.ref, err);
    }

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
