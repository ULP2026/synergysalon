/**
 * /api/staff/contacts: everyone the salon knows.
 *
 *   GET     ?q=&status=&stylist=&limit=   search and list
 *   GET     ?id=                 one person, their appointments and activity
 *   POST                         add somebody
 *   PATCH                        edit somebody
 *   DELETE                       remove somebody, here and in CENTRO
 *
 * One list, not two. A person who enquires on Tuesday and books on Thursday
 * is the same person, and keeping leads and clients apart guarantees they end
 * up in both with somebody merging them by hand later.
 */
import { assertSameOrigin, requireStaff } from '../../_lib/auth.js';
import { enqueueSync } from '../../_lib/booking.js';
import { query, transaction } from '../../_lib/db.js';
import {
  HttpError, handler, json, optionalPhone, readJson, requireId, requireString,
} from '../../_lib/http.js';
import { tenantForUser } from '../../_lib/tenant.js';
import { drain } from '../../cron/sync.js';

const STATUSES = ['new', 'contacted', 'booked', 'won', 'lost'];

/**
 * Deleting takes a salon's client out of both systems and cannot be undone,
 * so it is kept to the people who already decide who works there.
 */
const CAN_DELETE = ['owner', 'manager'];

/**
 * Remove a contact inside the caller's transaction.
 *
 * Their upcoming appointments are cancelled rather than left standing: an
 * appointment for nobody still blocks a stylist's chair. Past appointments are
 * kept, because they are the salon's record of work done and money taken;
 * they keep the guest's name on the appointment itself and lose only the link.
 *
 * Returns what CENTRO needs to be told, or null if the contact is not there.
 */
export async function removeContact(client, tenantId, id) {
  // Waits for any sync already pushing this person to finish, so the CENTRO
  // id it is about to store is the one read below. Taken before the contact
  // row, in the same order the sync takes them, so the two cannot deadlock.
  await client.query(
    `SELECT id FROM sync_outbox
      WHERE state = 'pending'
        AND (contact_id = $1
             OR appointment_id IN (SELECT id FROM appointments WHERE contact_id = $1))
      FOR UPDATE`,
    [id],
  );

  const { rows: found } = await client.query(
    'SELECT id, name, ghl_contact_id FROM contacts WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [id, tenantId],
  );
  const contact = found[0];
  if (!contact) return null;

  const { rows: cancelled } = await client.query(
    `UPDATE appointments SET status = 'cancelled', cancelled_at = now()
      WHERE contact_id = $1 AND status = 'booked' AND starts_at >= now()
      RETURNING id, ghl_appointment_id`,
    [id],
  );

  // Anything still waiting to go to CENTRO about this person would bring them
  // straight back: an unsent booking upserts its guest as a new contact.
  await client.query(
    `DELETE FROM sync_outbox
      WHERE state <> 'done'
        AND (contact_id = $1
             OR appointment_id IN (SELECT id FROM appointments WHERE contact_id = $1))`,
    [id],
  );

  await client.query('DELETE FROM contacts WHERE id = $1', [id]);

  const ghlAppointmentIds = cancelled.map((a) => a.ghl_appointment_id).filter(Boolean);
  if (contact.ghl_contact_id || ghlAppointmentIds.length) {
    // No contact_id on the job: that column cascades, and would delete the
    // job along with the person it is about.
    await enqueueSync(client, tenantId, 'contact.deleted', {
      payload: { ghlContactId: contact.ghl_contact_id, ghlAppointmentIds, name: contact.name },
    });
  }

  return { name: contact.name, cancelled: cancelled.length, inCentro: Boolean(contact.ghl_contact_id) };
}

/**
 * One contact for the detail view: who they are, their appointments, and a
 * timeline of what has actually happened with them.
 *
 * Every event comes from a timestamp the system already records. Nothing is
 * inferred and nothing is padded: there is no SMS or automation history yet,
 * so there are no SMS or automation events, rather than placeholders that
 * look like activity. The console says so instead.
 */
export async function contactDetail(tenantId, id) {
  const { rows: found } = await query(
    `SELECT id, name, email, phone, source, status, notes, created_at,
            first_booked_at, last_visit_at, ghl_contact_id, session_id
       FROM contacts WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [id, tenantId],
  );
  const c = found[0];
  if (!c) return null;

  const { rows: appts } = await query(
    `SELECT a.id, a.ref, a.starts_at, a.duration_min, a.status, a.channel,
            a.created_at, a.updated_at, a.cancelled_at, a.checked_in_at,
            a.reminder_sent_at, a.ghl_appointment_id,
            s.name AS stylist, v.name AS service
       FROM appointments a
       JOIN stylists s ON s.id = a.stylist_id
       JOIN services v ON v.id = a.service_id
      WHERE a.contact_id = $1::uuid AND a.tenant_id = $2::uuid
      ORDER BY a.starts_at DESC
      LIMIT 100`,
    [id, tenantId],
  );

  // Pushes to CENTRO that went through, for this person or their bookings.
  const { rows: synced } = await query(
    `SELECT kind, done_at FROM sync_outbox
      WHERE tenant_id = $2::uuid AND state = 'done' AND done_at IS NOT NULL
        AND (contact_id = $1::uuid
             OR appointment_id IN (SELECT id FROM appointments WHERE contact_id = $1::uuid))
      ORDER BY done_at DESC
      LIMIT 100`,
    [id, tenantId],
  );

  const activity = [];
  const add = (type, at, title, detail = '', ref = null) => {
    if (at) activity.push({ type, at, title, detail, ref });
  };

  // A contact with a booking session came in through the website wizard.
  add(c.session_id ? 'form' : 'lead', c.created_at,
      c.session_id ? 'Filled in the website booking form' : 'Added as a contact',
      c.source ? `Source: ${c.source}` : '');

  for (const a of appts) {
    const what = `${a.service} with ${a.stylist}`;
    add('appointment', a.created_at, a.channel === 'staff' ? 'Booked by staff' : 'Booked online',
        what, a.ref);
    add('appointment', a.checked_in_at, 'Checked in', what, a.ref);
    add('appointment', a.cancelled_at, 'Appointment cancelled', what, a.ref);
    // These two have no timestamp of their own; the last update is when
    // somebody marked them.
    if (a.status === 'completed') add('appointment', a.updated_at, 'Marked as done', what, a.ref);
    if (a.status === 'no_show') add('appointment', a.updated_at, 'Didn’t show up', what, a.ref);
    add('email', a.reminder_sent_at, 'Reminder email sent', what, a.ref);
  }
  for (const s of synced) {
    add('sync', s.done_at, 'Synced to the CRM', s.kind.replace('.', ' ').replace(/_/g, ' '));
  }
  activity.sort((x, y) => new Date(y.at) - new Date(x.at));

  return {
    contact: {
      id: c.id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      source: c.source,
      status: c.status,
      notes: c.notes,
      createdAt: c.created_at,
      firstBookedAt: c.first_booked_at,
      lastVisitAt: c.last_visit_at,
      inCentro: Boolean(c.ghl_contact_id),
    },
    appointments: appts.map((a) => ({
      ref: a.ref,
      startsAt: a.starts_at,
      durationMin: a.duration_min,
      status: a.status,
      channel: a.channel,
      checkedInAt: a.checked_in_at,
      service: a.service,
      stylist: a.stylist,
      syncedToCentro: Boolean(a.ghl_appointment_id),
    })),
    activity,
  };
}

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);
    const url = new URL(req.url, 'http://localhost');

    if (url.searchParams.has('id')) {
      const id = requireId(url.searchParams.get('id'), 'Contact');
      // Anything that is not a uuid cannot be a contact; saying so beats a
      // cast error from Postgres.
      const detail = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
        ? await contactDetail(tenant.id, id) : null;
      if (!detail) throw new HttpError(404, 'No such client.');
      return json(res, 200, detail);
    }

    const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
    const status = url.searchParams.get('status');
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 300);
    // A stylist's clients: anyone with an appointment in their chair that was
    // not cancelled. Booked-and-cancelled is not a relationship.
    const stylist = (url.searchParams.get('stylist') || '').trim().slice(0, 60) || null;

    const { rows } = await query(
      `SELECT c.id, c.name, c.email, c.phone, c.source, c.status, c.notes,
              c.first_booked_at, c.last_visit_at, c.created_at, c.ghl_contact_id,
              count(a.id) FILTER (WHERE a.status <> 'cancelled') AS visits,
              max(a.starts_at) FILTER (WHERE a.status = 'booked'
                                        AND a.starts_at >= now()) AS next_visit
         FROM contacts c
         LEFT JOIN appointments a ON a.contact_id = c.id
        WHERE c.tenant_id = $1
          AND ($2::text IS NULL OR c.status = $2::contact_status)
          AND ($3 = '' OR c.name ILIKE '%' || $3 || '%'
                       OR c.email ILIKE '%' || $3 || '%'
                       OR c.phone ILIKE '%' || $3 || '%')
          AND ($5::text IS NULL OR EXISTS (
                SELECT 1 FROM appointments sa
                  JOIN stylists ss ON ss.id = sa.stylist_id
                 WHERE sa.contact_id = c.id AND sa.status <> 'cancelled'
                   AND ss.slug = $5::text))
        GROUP BY c.id
        ORDER BY (c.status = 'new') DESC, c.created_at DESC
        LIMIT $4`,
      [tenant.id, STATUSES.includes(status) ? status : null, q, limit, stylist],
    );

    return json(res, 200, {
      count: rows.length,
      contacts: rows.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        phone: c.phone,
        source: c.source,
        status: c.status,
        notes: c.notes,
        visits: Number(c.visits),
        nextVisit: c.next_visit,
        firstBookedAt: c.first_booked_at,
        lastVisitAt: c.last_visit_at,
        createdAt: c.created_at,
        inCentro: Boolean(c.ghl_contact_id),
      })),
    });
  },

  async POST(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);
    const body = await readJson(req);

    const name = requireString(body.name, 'Name', { max: 120 });
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const phone = optionalPhone(body.phone);
    if (!email && !phone) {
      throw new HttpError(400, 'A client needs an email address or a phone number.');
    }

    const contact = await transaction(async (client) => {
      // Someone who rings twice should not become two people. Matched on
      // either identifier, because the front desk often has only one.
      const { rows: dup } = await client.query(
        `SELECT id, name FROM contacts
          WHERE tenant_id = $1
            AND (($2 <> '' AND lower(email) = $2) OR ($3 <> '' AND phone = $3))
          LIMIT 1`,
        [tenant.id, email, phone],
      );
      if (dup[0]) {
        throw new HttpError(409, `${dup[0].name} is already in your clients.`, 'DUPLICATE');
      }

      const { rows } = await client.query(
        `INSERT INTO contacts (tenant_id, name, email, phone, source, notes, created_by, assigned_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         RETURNING *`,
        [
          tenant.id, name, email, phone,
          (typeof body.source === 'string' ? body.source.trim() : '').slice(0, 60) || 'Staff console',
          typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) : '',
          user.id,
        ],
      );
      await enqueueSync(client, tenant.id, 'contact.created', { contactId: rows[0].id });
      return rows[0];
    });

    return json(res, 201, {
      id: contact.id,
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      status: contact.status,
    });
  },

  /**
   * PATCH: edit somebody's details.
   *
   * The change is pushed to CENTRO by id rather than by matching on email or
   * phone. Correcting either of those is the most common edit there is, and
   * matching would leave the salon with the same person twice.
   */
  async PATCH(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);
    const body = await readJson(req);

    const id = requireString(body.id, 'Contact', { max: 64 });
    const name = requireString(body.name, 'Name', { max: 120 });
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const phone = optionalPhone(body.phone);
    if (!email && !phone) {
      throw new HttpError(400, 'A client needs an email address or a phone number.');
    }
    const status = STATUSES.includes(body.status) ? body.status : null;

    const contact = await transaction(async (client) => {
      const { rows: dup } = await client.query(
        `SELECT name FROM contacts
          WHERE tenant_id = $1 AND id <> $2
            AND (($3 <> '' AND lower(email) = $3) OR ($4 <> '' AND phone = $4))
          LIMIT 1`,
        [tenant.id, id, email, phone],
      );
      if (dup[0]) {
        throw new HttpError(409, `Those details already belong to ${dup[0].name}.`, 'DUPLICATE');
      }

      const { rows } = await client.query(
        `UPDATE contacts
            SET name = $3, email = $4, phone = $5,
                source = COALESCE(NULLIF($6, ''), source),
                notes = $7,
                status = COALESCE($8::contact_status, status),
                updated_at = now()
          WHERE id = $2 AND tenant_id = $1
          RETURNING *`,
        [
          tenant.id, id, name, email, phone,
          typeof body.source === 'string' ? body.source.trim().slice(0, 60) : '',
          typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) : '',
          status,
        ],
      );
      if (!rows[0]) throw new HttpError(404, 'That client no longer exists.');

      await enqueueSync(client, tenant.id, 'contact.updated', { contactId: id });
      return rows[0];
    });

    try {
      await drain(10);
    } catch (err) {
      console.error('CENTRO sync deferred for contact', id, err);
    }

    return json(res, 200, {
      id: contact.id,
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      status: contact.status,
    });
  },

  async DELETE(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req, CAN_DELETE);
    const tenant = await tenantForUser(user);
    const body = await readJson(req);
    const id = requireString(body.id, 'Contact', { max: 64 });
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'Client is not valid.');

    const removed = await transaction((client) => removeContact(client, tenant.id, id));
    if (!removed) throw new HttpError(404, 'That client no longer exists.');

    // Inline, like an edit, so CENTRO matches by the time the list reloads.
    // If CENTRO is down the job stays queued and the cron finishes it.
    try {
      await drain(10);
    } catch (err) {
      console.error('CENTRO delete deferred for contact', id, err);
    }

    return json(res, 200, { id, ...removed });
  },
});
