/**
 * POST /api/enquiry — everything the booking wizard collects.
 *
 * The wizard on the homepage gathers seven steps of answers and, as shipped by
 * the design tool, sent them nowhere. This is where they go.
 *
 * Two rules shape it:
 *
 * The contact is saved first and the appointment attempted second. Somebody who
 * gets as far as typing their name and number is worth more to the salon than
 * a tidy failure, so a booking that cannot be honoured still leaves a lead the
 * front desk can ring back.
 *
 * It is called repeatedly as they type, not once at the end. A person who
 * abandons on the last step has still told us who they are and what they want.
 * Matching on email or phone means those repeats update one contact rather than
 * littering the list.
 */
import { DateTime } from 'luxon';

import { availableSlots } from './_lib/availability.js';
import { createBooking, enqueueSync } from './_lib/booking.js';
import { ONLINE_BOOKING } from './_lib/config.js';
import { previewAllowed } from './_lib/preview.js';
import { transaction } from './_lib/db.js';
import { sendConfirmation } from './_lib/email.js';
import {
  handler, json, readJson, requireString,
} from './_lib/http.js';
import { tenantForRequest } from './_lib/tenant.js';
import { drain } from './cron/sync.js';

/**
 * What the wizard calls a service, and what it is in the database.
 *
 * One to one, because the menu now holds every option the wizard offers. The
 * only deliberate merges are where two labels are genuinely the same work:
 * keratin and Brazilian blowout, Olaplex and K18.
 *
 * "Not sure yet" is absent on purpose. Someone who has not chosen cannot be
 * booked, so they are saved as a lead for the salon to call.
 */
const SERVICE_BY_LABEL = {
  "single process color": "single-process-color",
  "single process": "single-process-color",
  "highlights & foils": "highlights-and-foils",
  "balayage": "balayage",
  "biolage highlights": "biolage-highlights",
  "gloss or toner": "gloss-or-toner",
  "corrective color": "corrective-color",
  "color & cut": "color-and-cut",
  "women's cut": "womens-cut",
  "men's cut": "mens-cut",
  "teen cut": "teen-cut",
  "kids' cut": "kids-cut",
  "bang trim": "bang-trim",
  "keratin treatment": "keratin-and-brazilian-blowout",
  "brazilian blowout": "keratin-and-brazilian-blowout",
  "olaplex bond repair": "bond-repair",
  "k18 treatment": "bond-repair",
  "ai scalp analysis": "ai-scalp-analysis",
  "blowout": "blowouts",
  "special occasion updo": "special-event",
  "bridal styling": "bridal-styling",
  "extensions": "extensions",
};

const clean = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * An email only counts once it is whole.
 *
 * This endpoint is called as the guest types, so it sees every prefix of the
 * address on the way past. Treating those as real addresses did two kinds of
 * damage at once: each prefix looked like a different person and got its own
 * contact and its own appointment, and each was then pushed to CENTRO, which
 * rejected it with "email must be an email" — permanently, so the appointment
 * attached to it never reached the calendar either.
 *
 * A half-typed address is not a worse email. It is not an email yet.
 */
export function settledEmail(value) {
  const s = clean(value, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(s) ? s : '';
}

/**
 * The same rule for the phone box, and for the same reason: a number being
 * typed is not a short number, it is an unfinished one. Rejecting it outright
 * would turn every keystroke into a 400.
 */
export function settledPhone(value) {
  const s = clean(value, 40);
  return s.replace(/\D/g, '').length >= 7 ? s : '';
}

/** The id the wizard mints when it opens; the same for every call it makes. */
export function sessionIdFrom(value) {
  const s = clean(value, 64);
  return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : '';
}

function serviceSlugFor(label) {
  return SERVICE_BY_LABEL[clean(label).toLowerCase()] ?? null;
}

/**
 * The wizard renders its calendar as a month heading ("October 2026") and a
 * day number, and its times as text ("9:30 AM"). It never produces an ISO
 * date, so the pieces are reassembled here -- on the salon's clock, rather
 * than trusting whatever timezone the guest's laptop is set to.
 */
function startInstant(monthLabel, dayText, timeText, zone) {
  const month = clean(monthLabel, 40).replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const day = parseInt(clean(dayText, 4), 10);
  if (!month || !day || !timeText) return null;

  const when = DateTime.fromFormat(`${month} ${day}`, 'LLLL yyyy d', { zone });
  const dateISO = when.isValid ? when.toISODate() : null;
  if (!dateISO) return null;
  const t = clean(timeText, 20).toUpperCase().replace(/\s+/g, ' ');
  const m = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/);
  if (!m) return null;
  let hour = Number(m[1]) % 12;
  if (m[3] === 'PM') hour += 12;
  if (!m[3] && Number(m[1]) < 8) hour = Number(m[1]);   // a 24h clock, unlikely but harmless
  const dt = DateTime.fromISO(dateISO, { zone }).set({
    hour, minute: Number(m[2]), second: 0, millisecond: 0,
  });
  return dt.isValid ? dt : null;
}

/** Everything the guest told us, in the order they were asked. */
function notesFrom(body) {
  const lines = [];
  const add = (label, value) => {
    const v = Array.isArray(value) ? value.filter(Boolean).join(', ') : clean(value, 400);
    if (v) lines.push(`${label}: ${v}`);
  };
  // Guests can choose several services for one visit. The appointment is
  // booked against one of them; the stylist sets the real length from this.
  const services = Array.isArray(body.services)
    ? body.services.map((v) => clean(v, 80)).filter(Boolean).slice(0, 12)
    : [];
  if (services.length > 1) add('Services', services);
  else add('Service', services[0] || body.serviceLabel);
  add('Appointment for', body.who);
  add('Hair history (12 months)', body.history);
  add('Heard about us', body.heard);
  add('Stylist requested', body.stylistLabel);
  add('Notes', body.notes);
  return lines.join('\n').slice(0, 2000);
}

export default handler({
  async POST(req, res) {
    const tenant = await tenantForRequest(req);
    const body = await readJson(req);
    // Staff testing the paused popup with a pass from the console.
    const preview = previewAllowed(req, tenant);

    const name = requireString(body.name, 'Name', { max: 120 });
    const email = settledEmail(body.email);
    const phone = settledPhone(body.phone);
    const sessionId = sessionIdFrom(body.sessionId);

    // Nothing to attach a person to yet, and nothing this session has already
    // created. Saying so is cheaper than storing a record nobody can be
    // reached on.
    if (!email && !phone && !sessionId) {
      return json(res, 200, { saved: false, reason: 'no contact details yet' });
    }

    const serviceSlug = serviceSlugFor(body.serviceLabel);
    const start = startInstant(body.month, body.day, body.time, tenant.timezone);

    const result = await transaction(async (client) => {
      // Who this is, in order of how much the answer can be trusted.
      //
      // The session id first, because it is the only identifier that does not
      // change while they type. Then email or phone, which is what matches a
      // guest who has booked before to the record they already have.
      const { rows: found } = await client.query(
        `SELECT id, ghl_contact_id, email, phone FROM contacts
          WHERE tenant_id = $1
            AND (($2 <> '' AND session_id = $2)
              OR ($3 <> '' AND lower(email) = $3)
              OR ($4 <> '' AND phone = $4))
          ORDER BY ($2 <> '' AND session_id = $2) DESC, created_at
          LIMIT 1`,
        [tenant.id, sessionId, email, phone],
      );

      let contactId = found[0]?.id;
      if (contactId) {
        // Only overwrite a detail with one that is complete. Otherwise the
        // guest correcting a typo in their address would blank it on the way
        // through.
        await client.query(
          `UPDATE contacts
              SET name = $2,
                  email = CASE WHEN $3 <> '' THEN $3 ELSE email END,
                  phone = CASE WHEN $4 <> '' THEN $4 ELSE phone END,
                  session_id = COALESCE(NULLIF($6, ''), session_id),
                  -- "How did you hear" is now the last question, asked after
                  -- the contact already exists, so fill the source in late.
                  source = CASE WHEN $7::text <> '' AND source = 'Website booking form'
                                THEN $7::text ELSE source END,
                  notes = $5, updated_at = now()
            WHERE id = $1`,
          [contactId, name, email, phone, notesFrom(body), sessionId, clean(body.heard, 60)],
        );

        // Their details changed after CENTRO already had them — an address
        // finished, a number added. Push the correction rather than leaving
        // the mirror holding the older version.
        const before = found[0];
        const changed = (email && email !== (before.email || '').toLowerCase())
          || (phone && phone !== (before.phone || ''));
        if (before.ghl_contact_id && changed) {
          await enqueueSync(client, tenant.id, 'contact.updated', { contactId });
        }
      } else {
        // No record yet, and nothing to reach them on. Wait for one.
        if (!email && !phone) return { contactId: null, booked: null };

        const { rows } = await client.query(
          `INSERT INTO contacts (tenant_id, name, email, phone, source, notes, status, session_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'new', NULLIF($7, ''))
           RETURNING id`,
          [tenant.id, name, email, phone,
            clean(body.heard, 60) || 'Website booking form', notesFrom(body), sessionId],
        );
        contactId = rows[0].id;
        await enqueueSync(client, tenant.id, 'contact.created', { contactId });
      }

      // Book as soon as there is enough to book with, rather than waiting for
      // the wizard to say it has finished.
      //
      // That signal proved unreliable three separate ways -- the thank-you
      // panel, the Confirm click, a shared debounce -- and each time the
      // symptom was identical and silent: a lead saved, no appointment, and a
      // guest shown a thank-you. Having chosen a service, a stylist, a day and
      // a time, and typed their name and number, somebody has said everything
      // a booking needs. The flag is now only a hint.
      //
      // The cost is booking for someone who fills the last step and walks
      // away. That shows up in the diary where the salon can cancel it, which
      // is the better failure of the two.
      if (!serviceSlug || !start || !(ONLINE_BOOKING || preview)) {
        return { contactId, booked: null };
      }

      // One person, one appointment. This endpoint is called on every
      // keystroke, so without this a guest typing their email address books
      // themselves in once per character -- which is exactly what happened:
      // two bookings for the same slot, one from "test232" and one from
      // "test232@gmail.com", with different stylists.
      const { rows: live } = await client.query(
        `SELECT id, ref, starts_at, stylist_id FROM appointments
          WHERE contact_id = $1 AND status = 'booked' AND starts_at >= now()
          ORDER BY created_at DESC LIMIT 1`,
        [contactId],
      );

      if (live[0]) {
        const same = new Date(live[0].starts_at).getTime() === start.toMillis();
        if (same) return { contactId, booked: null, already: live[0].ref };
        // They have changed their mind mid-flow: move the appointment they
        // already have rather than leaving the salon holding both. The new
        // time is held to the same rules as a new booking, stylists' CENTRO
        // hours included; this path once moved people to any time at all.
        // A query error here would abort the transaction and lose the lead
        // saved above, so it counts as "not available" instead.
        await client.query('SAVEPOINT check_move');
        let days = [];
        try {
          ({ days } = await availableSlots(client, tenant, {
            serviceSlug,
            stylistSlug: clean(body.stylistSlug, 40) || null,
            fromDate: start.toISODate(),
            toDate: start.toISODate(),
            excludeAppointmentId: live[0].id,
            centro: false,   // our own hours, not a third party's
          }));
          await client.query('RELEASE SAVEPOINT check_move');
        } catch {
          await client.query('ROLLBACK TO SAVEPOINT check_move');
        }
        const slot = days.flatMap((d) => d.slots)
          .find((sl) => DateTime.fromISO(sl.start).toMillis() === start.toMillis());
        if (!slot) return { contactId, booked: null, already: live[0].ref, unavailable: true };
        const stylistId = slot.stylistIds.includes(live[0].stylist_id)
          ? live[0].stylist_id : slot.stylistIds[0];
        try {
          await client.query(
            `UPDATE appointments
                SET starts_at = $2::timestamptz, stylist_id = $3::uuid,
                    during = tstzrange($2::timestamptz,
                             $2::timestamptz + make_interval(mins => duration_min + buffer_min), '[)'),
                    updated_at = now()
              WHERE id = $1`,
            [live[0].id, start.toISO(), stylistId],
          );
          await enqueueSync(client, tenant.id, 'appointment.rescheduled',
                            { appointmentId: live[0].id });
          return { contactId, booked: null, already: live[0].ref, moved: true };
        } catch {
          return { contactId, booked: null, already: live[0].ref };
        }
      }

      try {
        const appt = await createBooking(client, tenant, {
          serviceSlug,
          stylistSlug: clean(body.stylistSlug, 40) || null,
          start: start.toISO(),
          guestName: name,
          guestEmail: email,
          guestPhone: phone,
          notes: notesFrom(body),
          channel: 'online',
          contactId,
        });
        return { contactId, booked: appt };
      } catch (err) {
        // The lead is already saved and committed with this transaction. A slot
        // that has gone in the meantime is worth reporting, not worth losing
        // the enquiry over.
        return { contactId, booked: null, bookingError: err.message };
      }
    });

    if (result.booked?.guest_email) {
      try {
        await sendConfirmation(result.booked, tenant);
      } catch (err) {
        console.error('confirmation email failed for', result.booked.ref, err);
      }
    }
    try {
      await drain(10);
    } catch (err) {
      console.error('CENTRO sync deferred', err);
    }

    return json(res, 200, {
      saved: Boolean(result.contactId),
      contactId: result.contactId,
      ref: result.booked?.ref ?? result.already ?? null,
      stylist: result.booked?.stylist_name ?? null,
      startsAt: result.booked?.starts_at ?? null,
      bookingError: result.bookingError ?? null,
    });
  },
});
