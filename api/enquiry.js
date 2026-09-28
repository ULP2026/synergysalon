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

import { createBooking, enqueueSync } from './_lib/booking.js';
import { transaction } from './_lib/db.js';
import { sendConfirmation } from './_lib/email.js';
import {
  handler, json, optionalPhone, readJson, requireString,
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
  add('Service', body.serviceLabel);
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

    const name = requireString(body.name, 'Name', { max: 120 });
    const email = clean(body.email, 254).toLowerCase();
    const phone = optionalPhone(body.phone);
    if (!email && !phone) {
      return json(res, 200, { saved: false, reason: 'no contact details yet' });
    }

    const serviceSlug = serviceSlugFor(body.serviceLabel);
    const start = startInstant(body.month, body.day, body.time, tenant.timezone);

    const result = await transaction(async (client) => {
      // Upsert on either identifier: the wizard calls this repeatedly as the
      // guest types, and each call must update the same person.
      const { rows: found } = await client.query(
        `SELECT id, ghl_contact_id FROM contacts
          WHERE tenant_id = $1
            AND (($2 <> '' AND lower(email) = $2) OR ($3 <> '' AND phone = $3))
          ORDER BY created_at LIMIT 1`,
        [tenant.id, email, phone],
      );

      let contactId = found[0]?.id;
      if (contactId) {
        await client.query(
          `UPDATE contacts
              SET name = $2,
                  email = CASE WHEN $3 <> '' THEN $3 ELSE email END,
                  phone = CASE WHEN $4 <> '' THEN $4 ELSE phone END,
                  notes = $5, updated_at = now()
            WHERE id = $1`,
          [contactId, name, email, phone, notesFrom(body)],
        );
      } else {
        const { rows } = await client.query(
          `INSERT INTO contacts (tenant_id, name, email, phone, source, notes, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'new')
           RETURNING id`,
          [tenant.id, name, email, phone,
            clean(body.heard, 60) || 'Website booking form', notesFrom(body)],
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
      if (!serviceSlug || !start) {
        return { contactId, booked: null };
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
        await sendConfirmation(result.booked, tenant.timezone);
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
      saved: true,
      contactId: result.contactId,
      ref: result.booked?.ref ?? null,
      stylist: result.booked?.stylist_name ?? null,
      startsAt: result.booked?.starts_at ?? null,
      bookingError: result.bookingError ?? null,
    });
  },
});
