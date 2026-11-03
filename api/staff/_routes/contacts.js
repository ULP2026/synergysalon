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
 *   PATCH  {id, op: 'tags'}      the team's tags for them, the whole list
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
import { messageClient, textBlock } from '../../_lib/client-message.js';
import { tenantForUser } from '../../_lib/tenant.js';
import { visitLinesSql, visitNameSql } from '../../_lib/visit.js';

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
/**
 * What each kind of email is, for one logged before its subject was kept
 * (037): the name its automation goes by.
 */
// Every kind email.js sends (MESSAGES); tests/client-email-activity checks
// none is missing.
export const EMAIL_KIND = {
  confirmation: 'Booking confirmation',
  reschedule: 'Appointment moved',
  cancellation: 'Appointment cancelled',
  reminder: 'Appointment reminder',
  welcome_new: 'Welcome before the first visit',
  no_show_1: 'We missed you today',
  no_show_2: 'Still happy to see you',
  late_cancel: 'Your appointment is cancelled',
  post_visit: 'How do you love it?',
  aftercare: 'Making it last',
  review_ask: 'Review request',
  rebook_due: 'Time for a refresh?',
  second_visit: 'Come back and see us',
  win_back: 'It has been a while',
};

/**
 * The automation that sends each kind of message, by the name it has in
 * Settings, Automations (asked for 2026-11-03): the client's Activity titles
 * an automated email or text with it ("Appointment Reminder"), not with a
 * generic "Email sent". The console's automation list uses the same names.
 */
export const AUTOMATION_NAME = {
  confirmation: 'Appointment Booking',
  reminder: 'Appointment Reminder',
  reschedule: 'Reschedule Notice',
  cancellation: 'Cancellation Notice',
  welcome_new: 'New Guest Welcome',
  no_show_1: 'No-show Recovery',
  no_show_2: 'No-show Recovery',
  late_cancel: 'Late Cancellation',
  post_visit: 'Post-visit Check-in',
  aftercare: 'Post-visit Check-in',
  review_ask: 'Review Request',
  rebook_due: 'Rebook Reminder',
  second_visit: 'New Guest Second Visit',
  win_back: 'Lapsed Client Win-back',
};

const TONE = {
  'Appointment Booked': 'booked',
  'Checked in': 'checkin',
  'Appointment cancelled': 'cancel',
  'Marked as done': 'done',
  'Didn’t show up': 'noshow',
  'Appointment Reminder': 'email',
};

/**
 * Who made a booking, in the words of the client's Activity (asked for
 * 2026-10-31): Karen, else the team member who booked it at the desk, by
 * name ("staff" only when their login has since been removed), else the
 * client themselves on the website. The console's appointment window and
 * Appt. Book say the same (bookedByLabel in the console).
 */
export function bookedLabel(a) {
  if (a.via === 'karen') return 'Booked by Karen';
  if (a.channel === 'staff') return `Booked by ${a.booked_by || 'staff'}`;
  return 'Booked by Client (Website)';
}

/**
 * Who did something on the client's Activity (asked for 2026-11-03), drawn
 * as a small picture beside it: Karen, a team member (by id, so the console
 * can show their face), the client themselves, an automation (by its name),
 * or "the team" where the app knows a person at the desk did it but not
 * which one. Left out where nothing recorded who it was, rather than
 * guessed.
 */
export function bookedBy(a) {
  if (a.via === 'karen') return { kind: 'karen', name: 'Karen' };
  if (a.channel === 'staff') {
    return a.booked_by_id
      ? { kind: 'staff', name: a.booked_by || 'Team member', id: a.booked_by_id }
      : { kind: 'team', name: 'The team' };
  }
  return { kind: 'client', name: 'Client (Website)' };
}

/**
 * The Admin history: what a change to a client's record says on their
 * Activity. `old` and `new` are as stored; empty reads as "(empty)".
 */
const CHANGE_TITLE = {
  name: 'Name updated',
  phone: 'Phone updated',
  email: 'Email updated',
  status: 'Status changed',
  notes: 'Notes edited',
  note: 'Note added',
  tag_added: 'Tag added',
  tag_removed: 'Tag removed',
  email_ok: 'Email follow-ups',
  sms_ok: 'Text messages',
  card_on_file: 'Card on file',
  source: 'Source updated',
};
const STATUS_WORD = { new: 'New', contacted: 'Contacted', booked: 'Booked', won: 'Client', lost: 'Lost' };
function changeLine(ch) {
  const show = (v) => {
    if (v == null || v === '') return '(empty)';
    if (ch.field === 'status') return STATUS_WORD[v] || v;
    if (ch.field === 'phone') return showPhoneText(v);
    return v;
  };
  if (ch.field === 'email_ok' || ch.field === 'sms_ok' || ch.field === 'card_on_file') {
    const on = ch.new_value === 'true';
    const what = ch.field === 'card_on_file' ? (on ? 'Card on file added' : 'Card on file removed')
      : `${CHANGE_TITLE[ch.field]} turned ${on ? 'on' : 'off'}`;
    return { title: what, detail: '' };
  }
  if (ch.field === 'note' || ch.field === 'tag_added' || ch.field === 'tag_removed') {
    return { title: CHANGE_TITLE[ch.field], detail: ch.new_value || ch.old_value || '' };
  }
  if (ch.field === 'notes') return { title: CHANGE_TITLE.notes, detail: '' };
  return { title: CHANGE_TITLE[ch.field] || 'Details updated', detail: `${show(ch.old_value)} → ${show(ch.new_value)}` };
}
/** A stored US number as (813) 555-0170, as the console shows it. */
function showPhoneText(v) {
  const d = String(v).replace(/\D/g, '');
  const ten = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : String(v);
}

/**
 * Keep one or more changes to a client's record for their Admin history.
 * Never stops the change itself: without the table (before 041) nothing is
 * kept, and a failure to keep it is logged, not thrown.
 */
export async function logChanges(q, tenantId, contactId, user, changes) {
  const rows = changes.filter((c) => String(c.old ?? '') !== String(c.new ?? '') || c.field === 'note'
    || c.field === 'tag_added' || c.field === 'tag_removed');
  if (!rows.length) return;
  try {
    // Asked first, so a database without 041 never sees a failed statement
    // (inside a transaction, one would undo the change itself).
    const { rows: has } = await q("SELECT to_regclass('contact_changes') IS NOT NULL AS ok");
    if (!has[0]?.ok) return;
    for (const c of rows) {
      await q(
        `INSERT INTO contact_changes (tenant_id, contact_id, changed_by, who_name, field, old_value, new_value)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text, $7::text)`,
        [tenantId, contactId, user?.id || null, user?.name || null, c.field,
          c.old == null ? null : String(c.old).slice(0, 2000), c.new == null ? null : String(c.new).slice(0, 2000)],
      );
    }
  } catch (err) {
    if (err.code !== '42P01') console.warn('contact_changes insert failed', err.message);
  }
}

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
            to_jsonb(contacts) ->> 'sms_consent_at' AS sms_consent_at,
            to_jsonb(contacts) ->> 'sms_consent_phone' AS sms_consent_phone,
            (SELECT to_jsonb(t) ->> 'karen_phone' FROM tenants t WHERE t.id = contacts.tenant_id) AS karen_phone,
            to_jsonb(contacts) -> 'card_on_file' AS card_on_file,
            to_jsonb(contacts) -> 'tags' AS tags,
            created_by, (SELECT u.name FROM staff_users u WHERE u.id = contacts.created_by) AS created_by_name
       FROM contacts WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [id, tenantId],
  );
  const c = found[0];
  if (!c) return null;

  const { rows: appts } = await q(
    `SELECT a.id, a.ref, a.starts_at, a.duration_min, a.status, a.channel,
            to_jsonb(a) ->> 'booked_via' AS via, b.name AS booked_by, a.booked_by AS booked_by_id, a.created_at, a.updated_at, a.cancelled_at, a.checked_in_at,
            a.reminder_sent_at,
            s.name AS stylist, s.slug AS stylist_slug, ${visitNameSql()} AS service,
            ${visitLinesSql()} AS lines, a.price_cents
       FROM appointments a
       JOIN stylists s ON s.id = a.stylist_id
       JOIN services v ON v.id = a.service_id
       LEFT JOIN staff_users b ON b.id = a.booked_by
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

  // Every email this client was sent, from the email log (asked for
  // 2026-10-31): theirs by client (037), by one of their appointments, or,
  // for a row with neither, by their address. Each is one line under Email
  // with its subject, when and whether it went, and opens the email itself.
  // Without the table (before 024) there are none; without 037's columns,
  // the same rows without subject or status.
  let emails = [];
  try {
    const { rows } = await q(
      `SELECT m.id, m.kind, m.sent_at, m.appointment_id, m.to_email,
              to_jsonb(m) ->> 'subject' AS subject,
              COALESCE(to_jsonb(m) ->> 'status', 'sent') AS status,
              to_jsonb(m) ->> 'error' AS error,
              to_jsonb(m) ->> 'body' AS body
         FROM message_sends m
        WHERE m.tenant_id = $2::uuid
          AND ((to_jsonb(m) ->> 'contact_id')::uuid = $1::uuid
               OR m.appointment_id IN (SELECT id FROM appointments WHERE contact_id = $1::uuid)
               OR (m.appointment_id IS NULL AND (to_jsonb(m) ->> 'contact_id') IS NULL
                   AND $3::text <> '' AND lower(m.to_email) = lower($3::text)))
        ORDER BY m.sent_at DESC
        LIMIT 200`,
      [id, tenantId, c.email || ''],
    );
    emails = rows;
  } catch (err) {
    if (err.code !== '42P01') throw err;
  }
  // A reminder in the log is listed from there; the appointment's own
  // reminder_sent_at is used only for one sent before the log existed, so
  // the same reminder is never listed twice.
  const logged = new Set(emails.filter((m) => m.kind === 'reminder' && m.status === 'sent')
    .map((m) => String(m.appointment_id)));

  const activity = [];
  const add = (type, at, title, detail = '', ref = null, extra = {}) => {
    if (at) activity.push({ type, at, title, detail, ref, tone: TONE[title] || type, ...extra });
  };
  // The team members named on this Activity, once each, so the console can
  // put their face beside what they did.
  const people = new Map();
  const staff = (id, name) => {
    if (!id) return { kind: 'team', name: name || 'The team' };
    if (!people.has(String(id))) people.set(String(id), name || 'Team member');
    return { kind: 'staff', name: name || 'Team member', id: String(id) };
  };
  const automation = (kind) => ({ kind: 'automation', name: AUTOMATION_NAME[kind] || 'Automation' });

  // Who made the record: the client on the website (a booking session, an
  // online booking or the opt-in form), a team member who added them, else
  // whoever made their first booking at the desk (a desk booking for a new
  // phone or email makes the client too), Karen included.
  const firstBooking = appts[appts.length - 1];
  const creator = c.session_id || /online|website|opt-in/i.test(c.source || '')
    ? { kind: 'client', name: 'Client (Website)' }
    : c.created_by ? staff(c.created_by, c.created_by_name)
      : firstBooking && firstBooking.channel === 'staff' ? (firstBooking.via === 'karen'
        ? { kind: 'karen', name: 'Karen' } : staff(firstBooking.booked_by_id, firstBooking.booked_by))
        : null;
  // "Client Created" whichever way they came (2026-11-03: the website
  // form's own "Filled in the website booking form" line was taken off;
  // the client (website) picture beside it says where they came from).
  add('lead', c.created_at, 'Client Created',
      c.source ? `Source: ${c.source}` : '', null, creator ? { by: creator } : {});

  for (const a of appts) {
    const what = `${a.service} with ${a.stylist}`;
    // Every event of a visit carries the visit's own date (asked for
    // 2026-11-03, in place of its reference number).
    const visit = { apptAt: a.starts_at };
    // "Appointment Booked" (2026-11-03; it was "Booked by …"), with who
    // booked it beside it: Karen (036), the team member at the desk, or the
    // client on the website.
    const by = bookedBy(a);
    if (by.kind === 'staff') people.set(by.id, by.name);
    add('appointment', a.created_at, 'Appointment Booked', what, a.ref, { tone: 'booked', by, bookedLabel: bookedLabel(a), ...visit });
    // Checked in, done and no-show are marked by somebody at the desk (or
    // Karen at their asking); the app does not keep which of them.
    add('appointment', a.checked_in_at, 'Checked in', what, a.ref, { by: { kind: 'team', name: 'The team' }, ...visit });
    add('appointment', a.cancelled_at, 'Appointment cancelled', what, a.ref, visit);
    // These two have no timestamp of their own; the last update is when
    // somebody marked them.
    if (a.status === 'completed') add('appointment', a.updated_at, 'Marked as done', what, a.ref, { by: { kind: 'team', name: 'The team' }, ...visit });
    if (a.status === 'no_show') add('appointment', a.updated_at, 'Didn’t show up', what, a.ref, { by: { kind: 'team', name: 'The team' }, ...visit });
    if (!logged.has(String(a.id))) {
      add('email', a.reminder_sent_at, AUTOMATION_NAME.reminder, what, a.ref, { by: automation('reminder'), kind: 'reminder', ...visit });
    }
  }
  const visitOf = new Map(appts.map((a) => [String(a.id), a]));
  for (const m of emails) {
    const a = visitOf.get(String(m.appointment_id));
    const subject = m.subject || EMAIL_KIND[m.kind] || 'Email';
    // An automation's email is titled with the automation (2026-11-03); one
    // written on the profile, with its subject, and its writer beside it.
    let by;
    if (m.kind === 'direct') {
      let from = null;
      try { from = JSON.parse(m.body || '{}').fromName || null; } catch { /* an older row */ }
      by = { kind: 'staff', name: from ? String(from).split(',')[0].trim() : 'The team' };
    } else by = automation(m.kind);
    // An automation's email reads as the automation and the visit, without
    // the email's own subject line under it (2026-11-03); the subject is
    // still in the email the line opens.
    add('email', m.sent_at, m.kind === 'direct' ? subject : AUTOMATION_NAME[m.kind] || subject,
      a ? `${a.service} with ${a.stylist}` : m.to_email, null, {
        sentId: m.id,
        kind: m.kind,
        subject: m.subject || null,
        status: m.status === 'failed' ? 'failed' : 'sent',
        error: m.status === 'failed' ? m.error || null : null,
        tone: m.status === 'failed' ? 'cancel' : 'email',
        by,
        ...(a ? { apptAt: a.starts_at } : {}),
      });
  }
  for (const s of synced) {
    add('sync', s.done_at, 'Synced to the CRM', s.kind.replace('.', ' ').replace(/_/g, ' '), null, { by: { kind: 'system', name: 'The app' } });
  }
  // Every text with them, either way (039, 2026-10-31): what the team sent
  // from here, the appointment texts, and their conversation with Karen.
  try {
    const { rows: texts } = await q(
      `SELECT x.direction, x.kind, x.body, x.status, x.error, x.created_at, x.sent_by AS sent_by_id, u.name AS sent_by
         FROM client_texts x LEFT JOIN staff_users u ON u.id = x.sent_by
        WHERE x.tenant_id = $2::uuid AND x.contact_id = $1::uuid
        ORDER BY x.created_at DESC LIMIT 200`,
      [id, tenantId],
    );
    for (const x of texts) {
      const auto = AUTOMATION_NAME[x.kind];
      const title = x.direction === 'in' ? 'Text from them'
        : x.kind === 'direct' ? `Text from ${x.sent_by ? String(x.sent_by).split(/\s+/)[0] : 'the team'}`
          : x.kind === 'karen' ? 'Karen replied by text' : auto || 'Text sent';
      const by = x.direction === 'in' ? { kind: 'client', name: c.name }
        : x.kind === 'direct' ? staff(x.sent_by_id, x.sent_by)
          : x.kind === 'karen' ? { kind: 'karen', name: 'Karen' }
            : auto ? automation(x.kind) : null;
      add('sms', x.created_at, title, x.body, null, {
        direction: x.direction,
        status: x.status === 'failed' ? 'failed' : 'sent',
        error: x.status === 'failed' ? x.error || null : null,
        tone: x.status === 'failed' ? 'cancel' : 'sms',
        ...(by ? { by } : {}),
      });
    }
  } catch (err) {
    if (err.code !== '42P01') throw err;
  }
  // The Admin history (041, 2026-11-03): every change the team made to the
  // record, what it was and what it became, by whom.
  try {
    const { rows: changes } = await q(
      `SELECT x.field, x.old_value, x.new_value, x.created_at, x.changed_by, COALESCE(u.name, x.who_name) AS who
         FROM contact_changes x LEFT JOIN staff_users u ON u.id = x.changed_by
        WHERE x.tenant_id = $2::uuid AND x.contact_id = $1::uuid
        ORDER BY x.created_at DESC LIMIT 200`,
      [id, tenantId],
    );
    for (const ch of changes) {
      const { title, detail } = changeLine(ch);
      add('admin', ch.created_at, title, detail, null, {
        field: ch.field, tone: 'admin', by: staff(ch.changed_by, ch.who),
      });
    }
  } catch (err) {
    if (err.code !== '42P01') throw err;
  }
  activity.sort((x, y) => new Date(y.at) - new Date(x.at));

  // Their stylist: the last one they were booked with, not cancelled.
  const latest = appts.find((a) => a.status !== 'cancelled');

  // The faces of the team members named above: an uploaded photo or chosen
  // avatar; the console falls back to a drawn one.
  const faces = {};
  if (people.size) {
    const { rows } = await q(
      `SELECT id, name, to_jsonb(u) ->> 'avatar' AS avatar FROM staff_users u WHERE id = ANY($1::uuid[])`,
      [[...people.keys()]],
    );
    for (const r of rows) faces[r.id] = { name: r.name, avatar: r.avatar || null };
  }

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
      // The team's tags for them (041), or null before it has run.
      tags: Array.isArray(c.tags) ? c.tags : null,
      // When they agreed to appointment texts (sms-opt-in or START), or null:
      // texts go only to a client who has (sms-notify.js).
      smsConsentAt: c.sms_consent_at || null,
      // Whether the team can text or email them from the profile, and if
      // not, why: shown under the message box (client-message.js).
      messaging: {
        text: textBlock(c, { karen_phone: c.karen_phone }),
        email: c.email ? null : 'There is no email address on file for them.',
      },
    },
    appointments: appts.map((a) => ({
      ref: a.ref,
      startsAt: a.starts_at,
      durationMin: a.duration_min,
      status: a.status,
      channel: a.channel,
      via: a.via || null,
      checkedInAt: a.checked_in_at,
      service: a.service,
      stylist: a.stylist,
    })),
    activity,
    people: faces,
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
  await logChanges(db ? db.query.bind(db) : query, tenantId, id, user, [{ field: 'note', new: text }]);
  return { id, notes: rows[0].notes };
}

/**
 * Whether the app may send this client follow-up emails, and texts. Two
 * separate switches. Refused, plainly, until migration 031 adds them.
 */
export async function setPrefs(tenantId, body, db = null, user = null) {
  const id = requireString(body.id, 'Contact', { max: 64 });
  if (!UUID.test(id)) throw new HttpError(400, 'Client is not valid.');
  if (typeof body.email !== 'boolean' || typeof body.sms !== 'boolean') {
    throw new HttpError(400, 'Say yes or no for email and for texts.');
  }
  if (!await hasColumn('contacts', 'email_ok', db) || !await hasColumn('contacts', 'sms_ok', db)) {
    throw new HttpError(409, 'Contact preferences are not switched on for this salon yet.', 'NOT_MIGRATED');
  }
  const q = db ? db.query.bind(db) : query;
  // What they were, read in the same statement, for the Admin history.
  const { rows } = await q(
    `UPDATE contacts c SET email_ok = $3::boolean, sms_ok = $4::boolean, updated_at = now()
       FROM (SELECT id, email_ok, sms_ok FROM contacts WHERE id = $1::uuid AND tenant_id = $2::uuid FOR UPDATE) o
      WHERE c.id = o.id
      RETURNING c.email_ok, c.sms_ok, o.email_ok AS was_email, o.sms_ok AS was_sms`,
    [id, tenantId, body.email, body.sms],
  );
  if (!rows[0]) throw new HttpError(404, 'That client no longer exists.');
  await logChanges(q, tenantId, id, user, [
    { field: 'email_ok', old: rows[0].was_email, new: rows[0].email_ok },
    { field: 'sms_ok', old: rows[0].was_sms, new: rows[0].sms_ok },
  ]);
  return { id, prefs: { email: rows[0].email_ok, sms: rows[0].sms_ok } };
}

/**
 * Card on file: whether the salon holds a card for this client, so a no-show
 * can be charged the fee and a visit paid through the stylist. Set by the
 * team; the app itself never sees a card.
 */
export async function setCard(tenantId, body, db = null, user = null) {
  const id = requireString(body.id, 'Contact', { max: 64 });
  if (!UUID.test(id)) throw new HttpError(400, 'Client is not valid.');
  if (typeof body.cardOnFile !== 'boolean') throw new HttpError(400, 'Say yes or no for the card.');
  if (!await hasColumn('contacts', 'card_on_file', db)) {
    throw new HttpError(409, 'Card on file is not switched on for this salon yet.', 'NOT_MIGRATED');
  }
  const q = db ? db.query.bind(db) : query;
  const { rows } = await q(
    `UPDATE contacts c SET card_on_file = $3::boolean, updated_at = now()
       FROM (SELECT id, card_on_file FROM contacts WHERE id = $1::uuid AND tenant_id = $2::uuid FOR UPDATE) o
      WHERE c.id = o.id
      RETURNING c.card_on_file, o.card_on_file AS was`,
    [id, tenantId, body.cardOnFile],
  );
  if (!rows[0]) throw new HttpError(404, 'That client no longer exists.');
  await logChanges(q, tenantId, id, user, [{ field: 'card_on_file', old: rows[0].was, new: rows[0].card_on_file }]);
  return { id, cardOnFile: rows[0].card_on_file };
}

/** Longest tag, and most tags on one client: labels, not notes. */
const TAG_MAX = 30;
const TAGS_MAX = 20;

/**
 * The team's tags for a client (asked for 2026-11-03): added, renamed and
 * removed from the profile's header. The whole list is sent each time, and
 * what was added and what was removed is kept for the Admin history.
 * Duplicates are dropped whatever their capitals; the first spelling wins.
 */
export async function setTags(tenantId, body, db = null, user = null) {
  const id = requireString(body.id, 'Contact', { max: 64 });
  if (!UUID.test(id)) throw new HttpError(400, 'Client is not valid.');
  if (!Array.isArray(body.tags)) throw new HttpError(400, 'Send the tags as a list.');
  const tags = [];
  for (const raw of body.tags) {
    if (typeof raw !== 'string') throw new HttpError(400, 'A tag is a few words.');
    const t = raw.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (t.length > TAG_MAX) throw new HttpError(400, `Keep each tag to ${TAG_MAX} characters.`);
    if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
  }
  if (tags.length > TAGS_MAX) throw new HttpError(400, `A client can have up to ${TAGS_MAX} tags.`);
  if (!await hasColumn('contacts', 'tags', db)) {
    throw new HttpError(409, 'Tags are not switched on for this salon yet.', 'NOT_MIGRATED');
  }
  const q = db ? db.query.bind(db) : query;
  const { rows } = await q(
    `UPDATE contacts c SET tags = $3::text[], updated_at = now()
       FROM (SELECT id, tags FROM contacts WHERE id = $1::uuid AND tenant_id = $2::uuid FOR UPDATE) o
      WHERE c.id = o.id
      RETURNING c.tags, o.tags AS was`,
    [id, tenantId, tags],
  );
  if (!rows[0]) throw new HttpError(404, 'That client no longer exists.');
  const was = rows[0].was || [];
  const low = (list) => new Set(list.map((x) => x.toLowerCase()));
  const before = low(was);
  const after = low(tags);
  await logChanges(q, tenantId, id, user, [
    ...was.filter((t) => !after.has(t.toLowerCase())).map((t) => ({ field: 'tag_removed', old: t, new: null })),
    ...tags.filter((t) => !before.has(t.toLowerCase())).map((t) => ({ field: 'tag_added', old: null, new: t })),
  ]);
  return { id, tags: rows[0].tags };
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
    if (body.op === 'prefs') return json(res, 200, await setPrefs(tenant.id, body, null, user));
    if (body.op === 'card') return json(res, 200, await setCard(tenant.id, body, null, user));
    if (body.op === 'tags') return json(res, 200, await setTags(tenant.id, body, null, user));
    // A text or an email written on their profile (2026-10-31).
    if (body.op === 'message') {
      return json(res, 200, await messageClient({
        tenant, user, contactId: body.id, channel: body.channel, subject: body.subject, text: body.text,
      }));
    }

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
      // As it was, for the Admin history of what changed.
      const { rows: before } = await client.query(
        'SELECT name, email, phone, status, notes, source FROM contacts WHERE id = $2 AND tenant_id = $1 FOR UPDATE',
        [tenant.id, id],
      );

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
      return { ...rows[0], was: before[0] || {} };
    });
    await logChanges(query, tenant.id, id, user,
      ['name', 'phone', 'email', 'status', 'source', 'notes'].map((f) => ({ field: f, old: contact.was[f], new: contact[f] })));

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
