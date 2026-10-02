/**
 * The calendars a shop creates for itself.
 *
 *   GET    /api/staff/booking-calendars            list them
 *   GET    /api/staff/booking-calendars?slug=x     one, with everything
 *   POST   /api/staff/booking-calendars            create
 *   PATCH  /api/staff/booking-calendars            change one
 *   DELETE /api/staff/booking-calendars            remove one
 *
 * A calendar is a way of being booked, not a second diary. Appointments still
 * live in one table, so two calendars pointing at the same stylist cannot both
 * sell the same hour -- the exclusion constraint sees all of them.
 */
import { assertSameOrigin, requireStaff } from '../../_lib/auth.js';
import { query, transaction } from '../../_lib/db.js';
import {
  HttpError, handler, json, readJson, requireString,
} from '../../_lib/http.js';
import { tenantForUser } from '../../_lib/tenant.js';

/** Creating and deleting a way to be booked is not a front-desk job. */
const CAN_MANAGE = ['owner', 'manager'];

/**
 * The kinds, and what each one actually does differently.
 *
 * Named as every CRM names them, so a shop arriving from one recognises the
 * list. The differences that matter here are how many people a booking takes
 * and how many guests share a slot; the rest is wording.
 */
export const KINDS = {
  personal: { label: 'Personal booking', members: 'one', capacity: 1 },
  round_robin: { label: 'Round robin', members: 'many', capacity: 1 },
  class: { label: 'Class booking', members: 'one', capacity: 'many' },
  collective: { label: 'Collective booking', members: 'many', capacity: 1 },
  event: { label: 'Event calendar', members: 'none', capacity: 'many' },
  service: { label: 'Service booking', members: 'many', capacity: 1 },
};

/**
 * A slug for the booking link.
 *
 * Derived from the name when one is not given, because nobody wants to type
 * the same words twice, and a shop that never looks at it still gets
 * something readable rather than a uuid.
 */
function slugify(value, fallback = 'calendar') {
  const s = String(value || '').toLowerCase().trim()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || fallback;
}

/** The first free variant of a slug, so a duplicate name is not an error. */
async function freeSlug(tenantId, wanted, exceptId = null) {
  for (let n = 0; n < 50; n += 1) {
    const candidate = n ? `${wanted}-${n + 1}` : wanted;
    const { rows } = await query(
      `SELECT 1 FROM booking_calendars
        WHERE tenant_id = $1 AND slug = $2 AND ($3::uuid IS NULL OR id <> $3::uuid)`,
      [tenantId, candidate, exceptId],
    );
    if (!rows.length) return candidate;
  }
  throw new HttpError(409, 'Too many calendars with that name.');
}

function shape(row, members = []) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    kindLabel: KINDS[row.kind]?.label ?? row.kind,
    description: row.description,
    durationMin: row.duration_min,
    bufferMin: row.buffer_min,
    capacity: row.capacity,
    acceptPayments: row.accept_payments,
    active: row.active,
    settings: row.settings ?? {},
    members,
    upcoming: row.upcoming ?? 0,
    createdAt: row.created_at,
  };
}

async function membersOf(ids) {
  if (!ids.length) return new Map();
  const { rows } = await query(
    `SELECT m.calendar_id, s.id, s.slug, s.name, m.sort_order
       FROM booking_calendar_members m
       JOIN stylists s ON s.id = m.stylist_id
      WHERE m.calendar_id = ANY($1::uuid[])
      ORDER BY m.sort_order, s.name`,
    [ids],
  );
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.calendar_id)) by.set(r.calendar_id, []);
    by.get(r.calendar_id).push({ id: r.id, slug: r.slug, name: r.name });
  }
  return by;
}

/** Replace a calendar's people in one go; the join table is the record. */
async function setMembers(client, calendarId, tenantId, stylistIds) {
  await client.query('DELETE FROM booking_calendar_members WHERE calendar_id = $1', [calendarId]);
  if (!stylistIds.length) return;
  await client.query(
    `INSERT INTO booking_calendar_members (calendar_id, stylist_id, sort_order)
     SELECT $1, s.id, ord.n
       FROM unnest($2::uuid[]) WITH ORDINALITY AS ord(sid, n)
       JOIN stylists s ON s.id = ord.sid AND s.tenant_id = $3
     ON CONFLICT DO NOTHING`,
    [calendarId, stylistIds, tenantId],
  );
}

function readIds(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => String(v || '').trim())
    .filter((v) => /^[0-9a-f-]{36}$/i.test(v))
    .slice(0, 50);
}

function clampInt(value, lo, hi, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);
    const url = new URL(req.url, 'http://localhost');
    const slug = url.searchParams.get('slug');

    const { rows } = await query(
      `SELECT c.*,
              count(a.id) FILTER (
                WHERE a.status = 'booked' AND a.starts_at >= now()
              )::int AS upcoming
         FROM booking_calendars c
         LEFT JOIN appointments a ON a.calendar_id = c.id
        WHERE c.tenant_id = $1 AND ($2::text IS NULL OR c.slug = $2)
        GROUP BY c.id
        ORDER BY c.active DESC, c.name`,
      [tenant.id, slug],
    );

    const by = await membersOf(rows.map((r) => r.id));
    const calendars = rows.map((r) => shape(r, by.get(r.id) ?? []));

    if (slug) {
      if (!calendars[0]) throw new HttpError(404, 'No calendar with that link.');
      return json(res, 200, { calendar: calendars[0] });
    }

    // The people a calendar can be given, so the form does not need a second
    // request to populate its picker.
    const { rows: team } = await query(
      `SELECT id, slug, name, title FROM stylists
        WHERE tenant_id = $1 AND active ORDER BY sort_order, name`,
      [tenant.id],
    );

    return json(res, 200, {
      calendars,
      team,
      kinds: Object.entries(KINDS).map(([k, v]) => ({ kind: k, label: v.label })),
      canManage: CAN_MANAGE.includes(user.role),
    });
  },

  async POST(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req, CAN_MANAGE);
    const tenant = await tenantForUser(user);
    const body = await readJson(req);

    const name = requireString(body.name, 'Calendar name', { max: 120 });
    const kind = requireString(body.kind, 'Calendar type', { max: 20 });
    if (!KINDS[kind]) throw new HttpError(400, 'That is not a calendar type.');

    const slug = await freeSlug(tenant.id, slugify(body.slug || name));
    const members = readIds(body.members);

    const created = await transaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO booking_calendars
           (tenant_id, name, slug, kind, description, duration_min, buffer_min,
            capacity, accept_payments, settings)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          tenant.id, name, slug, kind,
          String(body.description || '').trim().slice(0, 1000),
          clampInt(body.durationMin, 5, 600, 30),
          clampInt(body.bufferMin, 0, 240, 0),
          // Only a class or an event seats more than one guest at a time.
          kind === 'class' || kind === 'event' ? clampInt(body.capacity, 1, 200, 10) : 1,
          Boolean(body.acceptPayments),
          JSON.stringify(body.settings && typeof body.settings === 'object' ? body.settings : {}),
        ],
      );
      await setMembers(client, rows[0].id, tenant.id, members);
      return rows[0];
    });

    const by = await membersOf([created.id]);
    return json(res, 201, { calendar: shape(created, by.get(created.id) ?? []) });
  },

  async PATCH(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req, CAN_MANAGE);
    const tenant = await tenantForUser(user);
    const body = await readJson(req);

    const id = requireString(body.id, 'Calendar', { max: 64 });
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'Calendar is not valid.');

    const { rows: found } = await query(
      'SELECT * FROM booking_calendars WHERE id = $1 AND tenant_id = $2', [id, tenant.id],
    );
    const current = found[0];
    if (!current) throw new HttpError(404, 'That calendar no longer exists.');

    const sets = [];
    const params = [id];
    const add = (col, value) => { params.push(value); sets.push(`${col} = $${params.length}`); };

    if (body.name !== undefined) add('name', requireString(body.name, 'Calendar name', { max: 120 }));
    if (body.description !== undefined) {
      add('description', String(body.description || '').trim().slice(0, 1000));
    }
    if (body.durationMin !== undefined) add('duration_min', clampInt(body.durationMin, 5, 600, current.duration_min));
    if (body.bufferMin !== undefined) add('buffer_min', clampInt(body.bufferMin, 0, 240, current.buffer_min));
    if (body.capacity !== undefined) add('capacity', clampInt(body.capacity, 1, 200, current.capacity));
    if (body.acceptPayments !== undefined) add('accept_payments', Boolean(body.acceptPayments));
    if (body.active !== undefined) add('active', Boolean(body.active));

    if (body.slug !== undefined) {
      add('slug', await freeSlug(tenant.id, slugify(body.slug, current.slug), id));
    }

    // Settings are merged, not replaced: the Advanced page saves one section
    // at a time and must not blank the others on its way past.
    if (body.settings && typeof body.settings === 'object') {
      add('settings', JSON.stringify({ ...(current.settings ?? {}), ...body.settings }));
    }

    if (!sets.length && body.members === undefined) throw new HttpError(400, 'Nothing to change.');

    const updated = await transaction(async (client) => {
      let row = current;
      if (sets.length) {
        const { rows } = await client.query(
          `UPDATE booking_calendars SET ${sets.join(', ')}, updated_at = now()
            WHERE id = $1 RETURNING *`,
          params,
        );
        row = rows[0];
      }
      if (body.members !== undefined) {
        await setMembers(client, id, tenant.id, readIds(body.members));
      }
      return row;
    });

    const by = await membersOf([id]);
    return json(res, 200, { calendar: shape(updated, by.get(id) ?? []), saved: true });
  },

  async DELETE(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req, CAN_MANAGE);
    const tenant = await tenantForUser(user);
    const body = await readJson(req);
    const id = requireString(body.id, 'Calendar', { max: 64 });
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'Calendar is not valid.');

    // Appointments keep their place in the diary. A calendar is how a booking
    // was taken, not the booking: deleting the way in must not cancel somebody
    // who is turning up on Thursday.
    const { rows } = await query(
      `DELETE FROM booking_calendars WHERE id = $1 AND tenant_id = $2 RETURNING name`,
      [id, tenant.id],
    );
    if (!rows[0]) throw new HttpError(404, 'That calendar no longer exists.');
    return json(res, 200, { id, name: rows[0].name, deleted: true });
  },
});
