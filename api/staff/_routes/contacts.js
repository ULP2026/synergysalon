/**
 * /api/staff/contacts: everyone the salon knows.
 *
 *   GET     ?q=&status=&stylist=&member=&limit=   search and list
 *   GET     ?id=                 one person, their appointments and activity
 *   POST                         add somebody
 *   PATCH                        edit somebody
 *   PATCH  {id, op: 'note'}      add a dated note to the top of their notes
 *   PATCH  {id, op: 'prefs'}     whether they get follow-up emails, and texts
 *   PATCH  {id, op: 'card'}      whether the salon holds a card for them
 *   DELETE                       remove somebody
 *
 * One list, not two. A person who enquires on Tuesday and books on Thursday
 * is the same person, and keeping leads and clients apart guarantees they end
 * up in both with somebody merging them by hand later.
 */
import { assertSameOrigin, requireStaff } from '../../_lib/auth.js';
import { DEFAULT_TZ } from '../../_lib/config.js';
import { hasColumn, query, transaction } from '../../_lib/db.js';
import { mirrorToGoogle } from '../../_lib/google-mirror.js';
import {
  HttpError, handler, json, optionalPhone, readJson, requireId, requireString,
} from '../../_lib/http.js';
import { stylistPhoto } from '../../_lib/stylist-photos.js';
import { tenantForUser } from '../../_lib/tenant.js';

const STATUSES = ['new', 'contacted', 'booked', 'won', 'lost'];

/** Room for years of dated notes; the edit form and Add note share it. */
const NOTES_MAX = 8000;

/**
 * Each client's stylist: whoever they most recently booked with, not
 * counting cancellations. The tag a client wears in the list and on their
 * profile. Their source ("Front desk", "Online booking") is how the record
 * was made, which nobody filters a client list by; who looks after them is.
 */
const STYLIST_OF = `(SELECT jsonb_build_object('name', ts.name, 'slug', ts.slug)
     FROM appointments ta JOIN stylists ts ON ts.id = ta.stylist_id
    WHERE ta.contact_id = c.id AND ta.status <> 'cancelled'
    ORDER BY ta.starts_at DESC LIMIT 1)`;

/**
 * Everyone who has had a chair, for Choose your stylist: every stylist row,
 * with or without a login, a connected calendar or anything else, so long as
 * they are bookable now or somebody has booked them before. Somebody who has
 * left stays, marked, because their clients and history did not leave with
 * them.
 */
export async function stylistChoices(tenantId, db = null) {
  const { rows } = await (db ? db.query.bind(db) : query)(
    `SELECT s.slug, s.name, s.active, (to_jsonb(s) ->> 'removed_at') IS NOT NULL AS removed,
            to_jsonb(s) ->> 'photo' AS photo, to_jsonb(u) ->> 'avatar' AS avatar, t.slug AS tenant_slug
       FROM stylists s
       JOIN tenants t ON t.id = s.tenant_id
       LEFT JOIN staff_users u ON u.id = s.staff_user_id
      WHERE s.tenant_id = $1::uuid
        AND (s.active OR EXISTS (SELECT 1 FROM appointments a WHERE a.stylist_id = s.id))
      ORDER BY (s.active AND (to_jsonb(s) ->> 'removed_at') IS NULL) DESC, s.sort_order, s.name`,
    [tenantId],
  );
  // Their face on the filter: the picture they uploaded to their login, else
  // the salon's portrait of them, else the avatar they chose (the console
  // picks, in the same order as everywhere else). The website's portrait list
  // comes before the stored one, as in me.js: 012 stored a path for Tami
  // that was deleted when her photo was replaced.
  return rows.map((r) => ({
    slug: r.slug, name: r.name, left: r.removed || !r.active,
    photo: stylistPhoto(r.tenant_slug, r.slug) || r.photo || null, avatar: r.avatar || null,
  }));
}

/**
 * What kind of thing happened, finer than its type, so the timeline can
 * colour a check-in apart from a cancellation.
 */
const TONE = {
  'Booked by staff': 'booked',
  'Booked online': 'booked',
  'Checked in': 'checkin',
  'Appointment cancelled': 'cancel',
  'Marked as done': 'done',
  'Didn’t show up': 'noshow',
  'Reminder email sent': 'email',
};

/**
 * Deleting a salon's client cannot be undone, so it is kept to the people who
 * already decide who works there.
 */
const CAN_DELETE = ['owner', 'admin', 'manager'];

/**
 * Remove a contact inside the caller's transaction.
 *
 * Their upcoming appointments are cancelled rather than left standing: an
 * appointment for nobody still blocks a stylist's chair. Past appointments are
 * kept, because they are the salon's record of work done and money taken;
 * they keep the guest's name on the appointment itself and lose only the link.
 *
 * Returns who was removed and how many bookings went with them, or null if
 * the contact is not there.
 */
export async function removeContact(client, tenantId, id) {
  const { rows: found } = await client.query(
    'SELECT id, name FROM contacts WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [id, tenantId],
  );
  const contact = found[0];
  if (!contact) return null;

  const { rows: cancelled } = await client.query(
    `UPDATE appointments SET status = 'cancelled', cancelled_at = now()
      WHERE contact_id = $1 AND status = 'booked' AND starts_at >= now()
      RETURNING id`,
    [id],
  );

  await client.query('DELETE FROM contacts WHERE id = $1', [id]);

  return { name: contact.name, cancelled: cancelled.length };
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
export async function contactDetail(tenantId, id, db = null) {
  const q = db ? db.query.bind(db) : query;
  const { rows: found } = await q(
    `SELECT id, name, email, phone, source, status, notes, created_at,
            first_booked_at, last_visit_at, session_id,
            to_jsonb(contacts) -> 'email_ok' AS email_ok,
            to_jsonb(contacts) -> 'sms_ok' AS sms_ok,
            to_jsonb(contacts) -> 'card_on_file' AS card_on_file
       FROM contacts WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [id, tenantId],
  );
  const c = found[0];
  if (!c) return null;

  const { rows: appts } = await q(
    `SELECT a.id, a.ref, a.starts_at, a.duration_min, a.status, a.channel,
            a.created_at, a.updated_at, a.cancelled_at, a.checked_in_at,
            a.reminder_sent_at,
            s.name AS stylist, s.slug AS stylist_slug, v.name AS service
       FROM appointments a
       JOIN stylists s ON s.id = a.stylist_id
       JOIN services v ON v.id = a.service_id
      WHERE a.contact_id = $1::uuid AND a.tenant_id = $2::uuid
      ORDER BY a.starts_at DESC
      LIMIT 100`,
    [id, tenantId],
  );

  // Pushes to the CRM that went through, for this person or their bookings.
  // History: nothing has been sent there since 21 October 2026, but what was
  // sent before then really happened.
  const { rows: synced } = await q(
    `SELECT kind, done_at FROM sync_outbox
      WHERE tenant_id = $2::uuid AND state = 'done' AND done_at IS NOT NULL
        AND (contact_id = $1::uuid
             OR appointment_id IN (SELECT id FROM appointments WHERE contact_id = $1::uuid))
      ORDER BY done_at DESC
      LIMIT 100`,
    [id, tenantId],
  );

  // The reminder each booking was sent, from the email log, so its line in
  // the timeline opens the email itself (asked for 2026-10-31) rather than
  // the appointment. A reminder sent before the log existed has no row and
  // still opens the appointment. Without the table (before 024) there are
  // none.
  const reminderOf = new Map();
  if (appts.length) {
    try {
      const { rows: sent } = await q(
        `SELECT DISTINCT ON (m.appointment_id) m.id, m.appointment_id
           FROM message_sends m
          WHERE m.tenant_id = $2::uuid AND m.kind = 'reminder' AND m.appointment_id = ANY($1::uuid[])
          ORDER BY m.appointment_id, m.sent_at DESC`,
        [appts.map((a) => a.id), tenantId],
      );
      for (const r of sent) reminderOf.set(String(r.appointment_id), r.id);
    } catch (err) {
      if (err.code !== '42P01') throw err;
    }
  }

  const activity = [];
  const add = (type, at, title, detail = '', ref = null, extra = {}) => {
    if (at) activity.push({ type, at, title, detail, ref, tone: TONE[title] || type, ...extra });
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
    add('email', a.reminder_sent_at, 'Reminder email sent', what, a.ref,
        reminderOf.has(String(a.id)) ? { sentId: reminderOf.get(String(a.id)) } : {});
  }
  for (const s of synced) {
    add('sync', s.done_at, 'Synced to the CRM', s.kind.replace('.', ' ').replace(/_/g, ' '));
  }
  activity.sort((x, y) => new Date(y.at) - new Date(x.at));

  // Their stylist: the last one they were booked with, not cancelled.
  const latest = appts.find((a) => a.status !== 'cancelled');

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
      stylist: latest ? { name: latest.stylist, slug: latest.stylist_slug } : null,
      // null until migration 031 has run: the profile then says the choice
      // is not available yet, rather than offering a switch that saves
      // nowhere.
      prefs: c.email_ok == null && c.sms_ok == null
        ? null
        : { email: c.email_ok !== false, sms: c.sms_ok !== false },
      // null until migration 032 has run, for the same reason.
      cardOnFile: c.card_on_file == null ? null : c.card_on_file === true,
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
    })),
    activity,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Add note: one dated line on top of what is there, written in one
 * statement so two people adding notes at once both keep theirs. The edit
 * form still rewrites the whole field for anyone who wants to tidy it.
 */
export async function addNote(tenantId, user, body, db = null) {
  const id = requireString(body.id, 'Contact', { max: 64 });
  if (!UUID.test(id)) throw new HttpError(400, 'Client is not valid.');
  const text = requireString(body.note, 'Note', { max: 1000 });
  const stamp = new Date().toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: user.timezone || DEFAULT_TZ,
  });
  const line = `${stamp}, ${user.name || 'Staff'}: ${text}`;
  const { rows } = await (db ? db.query.bind(db) : query)(
    `UPDATE contacts
        SET notes = left(CASE WHEN btrim(notes) = '' THEN $3::text
                              ELSE $3::text || E'
' || notes END, $4::int),
            updated_at = now()
      WHERE id = $1::uuid AND tenant_id = $2::uuid
      RETURNING notes`,
    [id, tenantId, line, NOTES_MAX],
  );
  if (!rows[0]) throw new HttpError(404, 'That client no longer exists.');
  return { id, notes: rows[0].notes };
}

/**
 * Whether the app may send this client follow-up emails, and texts. Two
 * separate switches. Refused, plainly, until migration 031 adds them.
 */
export async function setPrefs(tenantId, body, db = null) {
  const id = requireString(body.id, 'Contact', { max: 64 });
  if (!UUID.test(id)) throw new HttpError(400, 'Client is not valid.');
  if (typeof body.email !== 'boolean' || typeof body.sms !== 'boolean') {
    throw new HttpError(400, 'Say yes or no for email and for texts.');
  }
  if (!await hasColumn('contacts', 'email_ok', db) || !await hasColumn('contacts', 'sms_ok', db)) {
    throw new HttpError(409, 'Contact preferences are not switched on for this salon yet.', 'NOT_MIGRATED');
  }
  const { rows } = await (db ? db.query.bind(db) : query)(
    `UPDATE contacts SET email_ok = $3::boolean, sms_ok = $4::boolean, updated_at = now()
      WHERE id = $1::uuid AND tenant_id = $2::uuid
      RETURNING email_ok, sms_ok`,
    [id, tenantId, body.email, body.sms],
  );
  if (!rows[0]) throw new HttpError(404, 'That client no longer exists.');
  return { id, prefs: { email: rows[0].email_ok, sms: rows[0].sms_ok } };
}

/**
 * Card on file: whether the salon holds a card for this client, so a no-show
 * can be charged the fee and a visit paid through the stylist. Set by the
 * team; the app itself never sees a card.
 */
export async function setCard(tenantId, body, db = null) {
  const id = requireString(body.id, 'Contact', { max: 64 });
  if (!UUID.test(id)) throw new HttpError(400, 'Client is not valid.');
  if (typeof body.cardOnFile !== 'boolean') throw new HttpError(400, 'Say yes or no for the card.');
  if (!await hasColumn('contacts', 'card_on_file', db)) {
    throw new HttpError(409, 'Card on file is not switched on for this salon yet.', 'NOT_MIGRATED');
  }
  const { rows } = await (db ? db.query.bind(db) : query)(
    `UPDATE contacts SET card_on_file = $3::boolean, updated_at = now()
      WHERE id = $1::uuid AND tenant_id = $2::uuid
      RETURNING card_on_file`,
    [id, tenantId, body.cardOnFile],
  );
  if (!rows[0]) throw new HttpError(404, 'That client no longer exists.');
  return { id, cardOnFile: rows[0].card_on_file };
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
    // The same, named by team member rather than by diary slug: the Clients
    // filters are the team, and a member's chair is whichever stylist row is
    // linked to their login. Somebody with no chair has no clients yet, which
    // is the honest answer for a placeholder filter.
    const memberParam = (url.searchParams.get('member') || '').trim();
    const member = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(memberParam)
      ? memberParam : null;

    const { rows } = await query(
      `SELECT c.id, c.name, c.email, c.phone, c.source, c.status, c.notes,
              c.first_booked_at, c.last_visit_at, c.created_at,
              count(a.id) FILTER (WHERE a.status <> 'cancelled') AS visits,
              ${STYLIST_OF} AS stylist,
              (to_jsonb(c) ->> 'card_on_file')::boolean AS card_on_file,
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
          AND ($6::uuid IS NULL OR EXISTS (
                SELECT 1 FROM appointments ma
                  JOIN stylists ms ON ms.id = ma.stylist_id
                 WHERE ma.contact_id = c.id AND ma.status <> 'cancelled'
                   AND ms.staff_user_id = $6::uuid))
        GROUP BY c.id
        ORDER BY (c.status = 'new') DESC, c.created_at DESC
        LIMIT $4`,
      [tenant.id, STATUSES.includes(status) ? status : null, q, limit, stylist, member],
    );

    return json(res, 200, {
      count: rows.length,
      // Only when asked: the booking window's name search does not need it.
      ...(url.searchParams.has('stylists') ? { stylists: await stylistChoices(tenant.id) } : {}),
      contacts: rows.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        phone: c.phone,
        source: c.source,
        status: c.status,
        notes: c.notes,
        visits: Number(c.visits),
        stylist: c.stylist || null,
        cardOnFile: c.card_on_file === true,
        nextVisit: c.next_visit,
        firstBookedAt: c.first_booked_at,
        lastVisitAt: c.last_visit_at,
        createdAt: c.created_at,
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

  /** PATCH: edit somebody's details. */
  async PATCH(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);
    const body = await readJson(req);

    if (body.op === 'note') return json(res, 200, await addNote(tenant.id, user, body));
    if (body.op === 'prefs') return json(res, 200, await setPrefs(tenant.id, body));
    if (body.op === 'card') return json(res, 200, await setCard(tenant.id, body));

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
          typeof body.notes === 'string' ? body.notes.trim().slice(0, NOTES_MAX) : '',
          status,
        ],
      );
      if (!rows[0]) throw new HttpError(404, 'That client no longer exists.');
      return rows[0];
    });

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

    // Their cancelled bookings come off the stylists' Google Calendars now
    // rather than at the daily cron.
    await mirrorToGoogle().catch((err) => console.error('google mirror deferred for contact', id, err));

    return json(res, 200, { id, ...removed });
  },
});
