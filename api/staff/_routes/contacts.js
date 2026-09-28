/**
 * /api/staff/contacts — everyone the salon knows.
 *
 *   GET     ?q=&status=&limit=   search and list
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
  HttpError, handler, json, optionalPhone, readJson, requireString,
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

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);
    const url = new URL(req.url, 'http://localhost');

    const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
    const status = url.searchParams.get('status');
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 300);

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
        GROUP BY c.id
        ORDER BY (c.status = 'new') DESC, c.created_at DESC
        LIMIT $4`,
      [tenant.id, STATUSES.includes(status) ? status : null, q, limit],
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
      throw new HttpError(400, 'A contact needs an email address or a phone number.');
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
        throw new HttpError(409, `${dup[0].name} is already in your contacts.`, 'DUPLICATE');
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
   * PATCH — edit somebody's details.
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
      throw new HttpError(400, 'A contact needs an email address or a phone number.');
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
      if (!rows[0]) throw new HttpError(404, 'That contact no longer exists.');

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
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'Contact is not valid.');

    const removed = await transaction((client) => removeContact(client, tenant.id, id));
    if (!removed) throw new HttpError(404, 'That contact no longer exists.');

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
