/**
 * POST /api/book — a guest booking themselves in from the website.
 *
 * The staff console books through the same code path in _lib/booking.js; the
 * only differences here are that an email address is required, because that is
 * where the confirmation goes, and that the normal minimum lead time applies.
 */
import { createBooking } from './_lib/booking.js';
import { transaction } from './_lib/db.js';
import { sendConfirmation } from './_lib/email.js';
import {
  handler, json, optionalPhone, readJson, requireEmail, requireId, requireString,
} from './_lib/http.js';
import { tenantForRequest } from './_lib/tenant.js';

export default handler({
  async POST(req, res) {
    const tenant = await tenantForRequest(req);
    const body = await readJson(req);

    const appointment = await transaction((client) => createBooking(client, tenant, {
      serviceSlug: requireId(body.service, 'Service'),
      stylistSlug: body.stylist && body.stylist !== 'any'
        ? requireId(body.stylist, 'Stylist')
        : null,
      start: requireString(body.start, 'Appointment time', { max: 40 }),
      guestName: requireString(body.name, 'Name', { max: 120 }),
      guestEmail: requireEmail(body.email),
      guestPhone: optionalPhone(body.phone),
      notes: typeof body.notes === 'string' ? body.notes.trim().slice(0, 1000) : '',
      channel: 'online',
    }));

    // The appointment exists. Email is a courtesy on top of it, never a
    // reason to tell the guest their booking failed.
    try {
      await sendConfirmation(appointment, tenant.timezone);
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
