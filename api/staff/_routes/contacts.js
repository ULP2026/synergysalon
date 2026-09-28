/**
 * /api/staff/contacts — everyone the salon knows.
 *
 *   GET   ?q=&status=&limit=   search and list
 *   POST                       add somebody
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

const STATUSES = ['new', 'contacted', 'booked', 'won', 'lost'];

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
});
