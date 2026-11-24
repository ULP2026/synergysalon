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
 * The survey's session id means those repeats update one contact rather than
 * littering the list.
 *
 * A guest is also matched to an existing client by email or phone, so a
 * returning client keeps one record. But a match by email or phone alone is
 * not proof it is the same person: anybody can type a client's address. So
 * only the session a contact was created in may change its details, only the
 * session that made an appointment may move it, and the reply only ever
 * describes an appointment this session made.
 */
import { DateTime } from 'luxon';

import { availableSlots } from './_lib/availability.js';
import { SLOT_UNAVAILABLE, createBooking } from './_lib/booking.js';
import { DEFAULT_TZ, ONLINE_BOOKING, shopFrom } from './_lib/config.js';
import { previewAllowed } from './_lib/preview.js';
import { hasColumn, query, transaction } from './_lib/db.js';
import { saveContactMessage, sendOptInConfirmation } from './_lib/contact-form.js';
import { calendarUrl, sendConfirmation, sendContactNotice } from './_lib/email.js';
import { emailProblem } from './_lib/email-check.js';
import { ensureSchema } from './_lib/ensure-schema.js';
import { mirrorToGoogle } from './_lib/google-mirror.js';
import {
  HttpError, handler, json, readJson, requireString,
} from './_lib/http.js';
import { tenantForRequest } from './_lib/tenant.js';

/**
 * The guest's booking when this request did not make it (2026-11-07). Their
 * details save as they type, so the booking is usually made a moment before
 * "Book Me Now!", whose own request then finds it already there; the
 * confirmation still needs the stylist actually booked and its calendar link.
 */
async function bookingByRef(tenantId, ref) {
  const { rows } = await query(
    `SELECT a.ref, a.starts_at, a.duration_min, s.name AS stylist_name,
            COALESCE((SELECT string_agg(x ->> 'name', ' + ')
                        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(to_jsonb(a) -> 'services') = 'array'
                                                       THEN to_jsonb(a) -> 'services' ELSE '[]'::jsonb END) x),
                     v.name) AS service_name
       FROM appointments a
       JOIN stylists s ON s.id = a.stylist_id
       JOIN services v ON v.id = a.service_id
      WHERE a.tenant_id = $1::uuid AND a.ref = $2::text AND a.status = 'booked'`,
    [tenantId, ref],
  );
  return rows[0] || null;
}

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
  // The menu of 2026-11-05: Partial and Full Highlights in place of
  // Highlights & Foils, no Teen Cut or Color & Cut, Bond Repair as one
  // choice, Condition and Mask Treatment, Updos for bridal and events, and
  // Consultation for what was Extensions. The old labels still map where
  // there is a service to map to, for a page cached from before.
  "highlights & foils": "full-highlights",
  "partial highlights": "partial-highlights",
  "full highlights": "full-highlights",
  "balayage": "balayage",
  "biolage highlights": "biolage-highlights",
  "gloss or toner": "gloss-or-toner",
  "corrective color": "corrective-color",
  "women's cut": "womens-cut",
  "men's cut": "mens-cut",
  "kids' cut": "kids-cut",
  "bang trim": "bang-trim",
  "keratin treatment": "keratin-and-brazilian-blowout",
  "brazilian blowout": "keratin-and-brazilian-blowout",
  "olaplex bond repair": "bond-repair",
  "k18 treatment": "bond-repair",
  "bond repair: olaplex & k18": "bond-repair",
  "k18/olaplex treatment": "bond-repair",
  "condition treatment": "condition-treatment",
  "mask treatment": "mask-treatment",
  "perm": "perm",
  "ai scalp analysis": "ai-scalp-analysis",
  "blowout": "blowouts",
  "shampoo blowout": "shampoo-blowout",
  "special occasion updo": "special-event",
  "bridal styling": "special-event",
  "updos": "special-event",
  "extensions": "extensions",
  "consultation": "extensions",
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
  // Nor is one with a slip in it ("gmail.conm", 2026-11-12): that is the same
  // as unfinished, and is said to the guest when they press Book Me Now.
  return emailProblem(s) ? '' : s;
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

/**
 * Whether the two columns (066) that decide what a request may touch are
 * there: which session booked an appointment, and when a session last
 * wrote to its contact.
 *
 * Asked of hasColumn, which remembers a yes for the life of the process, so
 * a warm function asks once. Only when one is missing is ensureSchema run
 * (it takes table locks even when there is nothing to add, so not on every
 * cold start of a public endpoint), and then the question is asked afresh.
 */
const SESSION_COLUMNS = [['appointments', 'booked_session_id'], ['contacts', 'session_at']];

async function sessionColumnsPresent(fresh) {
  for (const [table, column] of SESSION_COLUMNS) {
    if (!await hasColumn(table, column, null, { fresh })) return false;
  }
  return true;
}

async function defaultSessionColumnsReady() {
  if (await sessionColumnsPresent(false)) return true;
  await ensureSchema();
  return sessionColumnsPresent(true);
}

let sessionColumnsReady = defaultSessionColumnsReady;

/** For tests: answer "are the columns there" without touching the schema. */
export function setSessionColumnsReadyForTests(fn) {
  sessionColumnsReady = fn || defaultSessionColumnsReady;
}

/**
 * The lead alone, for when the session columns cannot be had. Who may
 * change or move what cannot be decided without them, so nothing is
 * booked or moved and no contact is changed; but a guest who has told us
 * who they are is still kept for the salon to ring. A new contact is saved
 * without a session id, since nothing could later prove it was this
 * session's.
 */
async function saveLeadOnly(tenant, { name, email, phone, body }) {
  if (!email && !phone) return null;
  return transaction(async (client) => {
    const { rows: found } = await client.query(
      `SELECT id FROM contacts
        WHERE tenant_id = $1::uuid
          AND (($2::text <> '' AND lower(email) = $2::text) OR ($3::text <> '' AND phone = $3::text))
        ORDER BY created_at LIMIT 1`,
      [tenant.id, email, phone],
    );
    if (found[0]) return found[0].id;
    const { rows } = await client.query(
      `INSERT INTO contacts (tenant_id, name, email, phone, source, notes, status)
       VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, 'new')
       RETURNING id`,
      [tenant.id, name, email, phone, clean(body.heard, 60) || 'Website booking form', notesFrom(body)],
    );
    return rows[0].id;
  });
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
  // Guests can choose several services for one visit. They are booked as one
  // appointment long enough for all of them; the list is kept here as well.
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
    // The contact page's form (synergysalon.com/sms-opt-in) comes in here too,
    // because a file of its own would be a thirteenth function. It is a
    // message and an optional texting consent, not a booking.
    if (body.kind === 'contact') {
      const saved = await saveContactMessage(tenant, body);
      if (saved.contactId) {
        try { await sendContactNotice(saved, tenant); } catch (err) { console.error('contact notice email failed', err); }
      }
      if (saved.contactId && saved.consent) {
        try { await sendOptInConfirmation(tenant, saved.phone); } catch (err) { console.error('opt-in confirmation text failed', err); }
      }
      return json(res, 200, { saved: true });
    }
    // Staff testing the paused popup with a pass from the console.
    const preview = previewAllowed(req, tenant);

    const name = requireString(body.name, 'Name', { max: 120 });
    const email = settledEmail(body.email);
    const phone = settledPhone(body.phone);
    const sessionId = sessionIdFrom(body.sessionId);
    // Something is in the email box that is not an address yet: half typed,
    // or with a slip in it ("gmail.conm"). The booking waits for it (below),
    // or a guest would be booked with no email and never hear a word; and on
    // "Book Me Now!" the guest is told what is wrong, so they can fix it.
    const emailWaiting = Boolean(clean(body.email, 254)) && !email;
    if (body.complete && emailWaiting) {
      throw new HttpError(400, emailProblem(clean(body.email, 254)) || 'Please check your email address.', 'BAD_EMAIL');
    }

    // Nothing to attach a person to yet, and nothing this session has already
    // created. Saying so is cheaper than storing a record nobody can be
    // reached on.
    if (!email && !phone && !sessionId) {
      return json(res, 200, { saved: false, reason: 'no contact details yet' });
    }

    const serviceSlug = serviceSlugFor(body.serviceLabel);
    // Every other service picked for the same visit. They are booked
    // together, end to end with one stylist, as one appointment.
    const extraServiceSlugs = [...new Set((Array.isArray(body.services) ? body.services : [])
      .map((v) => serviceSlugFor(v)).filter((x) => x && x !== serviceSlug))];
    const start = startInstant(body.month, body.day, body.time, tenant.timezone);

    // Which session booked an appointment, and when a session last wrote to
    // its contact (066), decide what this request may touch, so they must
    // exist before it runs rather than be guessed at. If they cannot be had,
    // the lead is still kept (the rule above) and the guest is asked to call:
    // never a booking decided without them, and never a lost lead.
    if (!await sessionColumnsReady()) {
      console.error('enquiry: session columns (066) missing; lead saved, nothing booked');
      const contactId = await saveLeadOnly(tenant, { name, email, phone, body });
      return json(res, 200, {
        saved: Boolean(contactId),
        ref: null,
        stylist: null,
        startsAt: null,
        calendar: null,
        bookingError: 'call_salon',
      });
    }

    const result = await transaction(async (client) => {
      // Who this is, in order of how much the answer can be trusted.
      //
      // The session id first, because it is the only identifier that does not
      // change while they type. Then email or phone, which is what matches a
      // guest who has booked before to the record they already have.
      //
      // A session id only counts with session_at: the survey once wrote the
      // typed session id onto any contact whose email or phone matched, so an
      // id with no record of when this code wrote it, or one over a day old,
      // is not proof the contact is this session's, and finds nothing by
      // itself; the email or phone may still match as for anyone.
      const { rows: found } = await client.query(
        `SELECT id, email, phone,
                COALESCE($2::text <> '' AND session_id = $2::text
                         AND session_at > now() - interval '24 hours', false) AS by_session
           FROM contacts
          WHERE tenant_id = $1::uuid
            AND (($2::text <> '' AND session_id = $2::text
                  AND session_at IS NOT NULL AND session_at > now() - interval '24 hours')
              OR ($3::text <> '' AND lower(email) = $3::text)
              OR ($4::text <> '' AND phone = $4::text))
          ORDER BY by_session DESC, created_at
          LIMIT 1`,
        [tenant.id, sessionId, email, phone],
      );

      let contactId = found[0]?.id;
      // Whether this contact is this session's own: found by the session id
      // it was given here, or created just now with it. Only then may what
      // was typed change it.
      let ownContact = Boolean(found[0]?.by_session);
      if (contactId && !ownContact) {
        // Matched by email or phone alone (or by a session id that proves
        // nothing), which anybody can type. The booking is linked to the
        // client's record, but nothing on it is changed: not their name,
        // details, notes, source or session.
      } else if (contactId) {
        // Only overwrite a detail with one that is complete. Otherwise the
        // guest correcting a typo in their address would blank it on the way
        // through.
        await client.query(
          `UPDATE contacts
              SET name = $2,
                  email = CASE WHEN $3 <> '' THEN $3 ELSE email END,
                  phone = CASE WHEN $4 <> '' THEN $4 ELSE phone END,
                  session_id = COALESCE(NULLIF($6, ''), session_id),
                  session_at = now(),
                  -- "How did you hear" is now the last question, asked after
                  -- the contact already exists, so fill the source in late.
                  source = CASE WHEN $7::text <> '' AND source = 'Website booking form'
                                THEN $7::text ELSE source END,
                  notes = $5, updated_at = now()
            WHERE id = $1`,
          [contactId, name, email, phone, notesFrom(body), sessionId, clean(body.heard, 60)],
        );

      } else {
        // No record yet, and nothing to reach them on. Wait for one.
        if (!email && !phone) return { contactId: null, booked: null };

        const { rows } = await client.query(
          `INSERT INTO contacts (tenant_id, name, email, phone, source, notes, status,
                                 session_id, session_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'new', NULLIF($7::text, ''),
                   CASE WHEN $7::text <> '' THEN now() END)
           RETURNING id`,
          [tenant.id, name, email, phone,
            clean(body.heard, 60) || 'Website booking form', notesFrom(body), sessionId],
        );
        contactId = rows[0].id;
        ownContact = Boolean(sessionId);
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
      if (!serviceSlug || !start || !(ONLINE_BOOKING || preview) || emailWaiting) {
        return { contactId, booked: null };
      }

      // One person, one appointment. This endpoint is called on every
      // keystroke, so without this a guest typing their email address books
      // themselves in once per character -- which is exactly what happened:
      // two bookings for the same slot, one from "test232" and one from
      // "test232@gmail.com", with different stylists.
      //
      // One per session, not per contact: only an appointment this session
      // booked is its own to keep or move. The contact's others (another
      // session's, the desk's, Karen's, or from before sessions were kept)
      // are never moved from here, and nothing about them is replied.
      //
      // Found by the session alone, whichever contact it is on: a guest
      // whose details change mid-flow may now be matched to another record,
      // and must still move the booking they made rather than make a second.
      let live = [];
      if (sessionId) {
        ({ rows: live } = await client.query(
          `SELECT id, ref, starts_at, stylist_id FROM appointments
            WHERE tenant_id = $1::uuid AND booked_session_id = $2::text
              AND status = 'booked' AND starts_at >= now()
            ORDER BY created_at DESC LIMIT 1`,
          [tenant.id, sessionId],
        ));
      }

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
        let visits = new Map();
        let service = null;
        try {
          ({ days, visits, service } = await availableSlots(client, tenant, {
            serviceSlug,
            extraServiceSlugs,
            google: true,
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
        // As that stylist would do it: their length and processing breaks.
        const visit = visits.get(stylistId);
        try {
          // The length follows what they picked this time, so changing the
          // services mid-flow is not left booked at the old length.
          await client.query(
            `UPDATE appointments
                SET starts_at = $2::timestamptz, stylist_id = $3::uuid,
                    duration_min = $4::int, buffer_min = $5::int,
                    price_cents = $6::int, breaks = $7::jsonb,
                    during = tstzrange($2::timestamptz,
                             $2::timestamptz + make_interval(mins => $4::int + $5::int), '[)'),
                    -- And which services it is now, with the guest's own
                    -- list in the notes, so the ticket and the emails name
                    -- what they picked this time, not what they first did.
                    service_id = $8::uuid, notes = $9::text,
                    updated_at = now()
              WHERE id = $1`,
            [live[0].id, start.toISO(), stylistId, visit.durationMin, visit.bufferMin, visit.priceCents,
             JSON.stringify(visit.breaks || []), service.id, notesFrom(body)],
          );
          // The itemized lines (031), when the database has the column.
          if (visit.lines?.length && await hasColumn('appointments', 'services', client)) {
            await client.query('UPDATE appointments SET services = $2::jsonb WHERE id = $1::uuid',
              [live[0].id, JSON.stringify(visit.lines)]);
          }
          return { contactId, booked: null, already: live[0].ref, moved: true };
        } catch {
          return { contactId, booked: null, already: live[0].ref };
        }
      }

      // The session's own contact, already booked at this very time some
      // other way (at the desk, say): not booked twice. Only for a contact
      // this session owns. For one matched by email or phone the request
      // goes the way any guest's does, so neither its answer nor how long it
      // takes says whether that client has a visit then; a stylist who
      // really is taken is still refused by the diary itself.
      if (ownContact) {
        const { rows: clash } = await client.query(
          `SELECT 1 FROM appointments
            WHERE contact_id = $1::uuid AND status = 'booked' AND starts_at = $2::timestamptz
            LIMIT 1`,
          [contactId, start.toISO()],
        );
        if (clash[0]) return { contactId, booked: null, bookingError: SLOT_UNAVAILABLE };
      }

      try {
        const appt = await createBooking(client, tenant, {
          serviceSlug,
          extraServiceSlugs,
          stylistSlug: clean(body.stylistSlug, 40) || null,
          start: start.toISO(),
          guestName: name,
          guestEmail: email,
          guestPhone: phone,
          notes: notesFrom(body),
          channel: 'online',
          contactId,
        });
        // Which session made it, so later saves from this session find it
        // and no other session's do.
        if (sessionId) {
          await client.query(
            'UPDATE appointments SET booked_session_id = $2::text WHERE id = $1::uuid',
            [appt.id, sessionId],
          );
        }
        return { contactId, booked: appt };
      } catch (err) {
        // The lead is already saved and committed with this transaction. A slot
        // that has gone in the meantime is worth reporting, not worth losing
        // the enquiry over.
        return { contactId, booked: null, bookingError: err.message };
      }
    });

    if (result.booked) {
      try {
        await sendConfirmation(result.booked, tenant);
      } catch (err) {
        console.error('confirmation email failed for', result.booked.ref, err);
      }
    }
    await mirrorToGoogle().catch((err) => console.error('google mirror deferred', err));

    const appt = result.booked
      || (result.already ? await bookingByRef(tenant.id, result.already).catch(() => null) : null);
    return json(res, 200, {
      // Whether the lead was kept, but not its record's id: that would say
      // which address or number is already a client, and nothing on the
      // page needs it.
      saved: Boolean(result.contactId),
      ref: result.booked?.ref ?? result.already ?? null,
      stylist: appt?.stylist_name ?? null,
      startsAt: appt?.starts_at ?? null,
      // Add to my Calendar on the website's confirmation (2026-11-07): the
      // confirmation email's own link, so the two never disagree on the time.
      calendar: appt ? calendarUrl(appt, shopFrom(tenant), tenant.timezone || DEFAULT_TZ) || null : null,
      bookingError: result.bookingError ?? null,
    });
  },
});
