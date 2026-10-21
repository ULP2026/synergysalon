/**
 * POST /api/book — a guest booking themselves in from the website.
 *
 * The staff console books through the same code path in _lib/booking.js; the
 * only differences here are that an email address is required, because that is
 * where the confirmation goes, and that the normal minimum lead time applies.
 */
import { createBooking } from './_lib/booking.js';
import { ONLINE_BOOKING } from './_lib/config.js';
import { previewAllowed } from './_lib/preview.js';
import { query, transaction } from './_lib/db.js';
import { sendConfirmation } from './_lib/email.js';
import { mirrorToGoogle } from './_lib/google-mirror.js';
import { at, enqueue } from './_lib/scheduled.js';
import {
  handler, json, optionalPhone, readJson, requireEmail, requireId, requireString,
} from './_lib/http.js';
import { tenantForRequest } from './_lib/tenant.js';

export default handler({
  async POST(req, res) {
    const tenant = await tenantForRequest(req);
    // Paused while stylists set their hours; the site asks guests to call.
    // Staff with a test pass from the console may still book.
    if (!ONLINE_BOOKING && !previewAllowed(req, tenant)) {
      return json(res, 503, {
        error: 'Online appointments are coming soon. Please call the salon to book.',
      });
    }
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

    // The appointment exists. Everything after this point is a courtesy on
    // top of it, never a reason to tell the guest their booking failed.
    try {
      await sendConfirmation(appointment, tenant);
    } catch (err) {
      console.error('confirmation email failed for', appointment.ref, err);
    }

    await queueWelcome(appointment, tenant);

    // Onto the stylist's Google Calendar now rather than at the daily cron,
    // which puts right anything that fails here.
    await mirrorToGoogle().catch((err) => console.error('google mirror deferred for', appointment.ref, err));

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
