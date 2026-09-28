/**
 * POST /api/book — a guest booking themselves in from the website.
 *
 * The staff console books through the same code path in _lib/booking.js; the
 * only differences here are that an email address is required, because that is
 * where the confirmation goes, and that the normal minimum lead time applies.
 */
import { drain } from './cron/sync.js';
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

    // The appointment exists. Everything after this point is a courtesy on
    // top of it, never a reason to tell the guest their booking failed.
    try {
      await sendConfirmation(appointment, tenant.timezone);
    } catch (err) {
      console.error('confirmation email failed for', appointment.ref, err);
    }

    // Push this booking to CENTRO now rather than waiting for the nightly
    // sweep. The Hobby plan allows one cron run a day, so a queue that only
    // drains on a schedule would leave the salon's CRM a day behind. The
    // outbox row is already committed, so a failure here is picked up by the
    // cron rather than lost.
    // Not drain(1): the queue may already hold older jobs, and draining a
    // single one would push somebody else's contact while this appointment sat
    // waiting for a cron that runs once a day. Bounded so a large backlog
    // cannot hold up the reply.
    try {
      await drain(10);
    } catch (err) {
      console.error('CENTRO sync deferred for', appointment.ref, err);
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
