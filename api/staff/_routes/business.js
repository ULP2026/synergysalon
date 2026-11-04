/**
 * GET   /api/staff/business: what the shop tells its customers.
 * PATCH /api/staff/business: change it. Owners and managers.
 *
 * Deliberately narrow. This edits the shop's name, logo and contact details,
 * and nothing operational: not the timezone, which would move every slot in
 * the diary at once, not the hostname, which decides whose bookings arrive
 * here, and not the CRM credentials, which are never returned by any endpoint
 * to begin with. Those are support's job, and the blast radius is the reason.
 */
import { DateTime } from 'luxon';

import { assertSameOrigin, requireStaff } from '../../_lib/auth.js';
import { assertClientInChair, chairOf, clientInChairSql, seesAll } from '../../_lib/scope.js';
import { query } from '../../_lib/db.js';
import {
  INVITE_KIND, INVITE_REMINDER_KIND, MESSAGE_KINDS, automationOn, previewInvite, previewMessage, previewStaffEmail,
} from '../../_lib/email.js';
import { inviteText } from '../../_lib/sms-notify.js';
import { sendCashoutNotice } from '../../_lib/email.js';

/**
 * Every automation's kinds: the guest messages, then the Team Member
 * Invitation (2026-11-04), which goes to the team rather than to a client,
 * so it has no appointment and is not in MESSAGE_KINDS (the queue and the
 * client's Activity only ever deal in those).
 */
const AUTOMATION_KINDS = [...MESSAGE_KINDS, INVITE_KIND, INVITE_REMINDER_KIND];
const TEAM_KINDS = [INVITE_KIND, INVITE_REMINDER_KIND];
import { prettyPhone, smsText } from '../../_lib/karen-sms.js';
import {
  HttpError, handler, json, readJson, requireEmail, requireString,
} from '../../_lib/http.js';
import { tenantForUser } from '../../_lib/tenant.js';
import { visitLinesSql, visitNameSql } from '../../_lib/visit.js';

/**
 * The same people who run Settings. Owner-only left the salon's own manager
 * looking at a form they could not type in, while the address and phone
 * customers see needed fixing; front desk still only reads it.
 */
const CAN_EDIT = ['owner', 'admin', 'manager'];

const MAX_LOGO = 400 * 1024;

function logoFrom(value) {
  if (value === null) return null;
  const s = String(value || '').trim();
  if (!s) return undefined;
  if (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(s)) {
    throw new HttpError(400, 'That does not look like an image.');
  }
  if (s.length > MAX_LOGO) {
    throw new HttpError(413, 'That logo is too large. Please choose a smaller one.');
  }
  return s;
}

/**
 * GET ?preview=confirmation|reminder|reschedule|cancellation: a guest message
 * rendered by the same code that sends it, for Marketing, Automation.
 *
 * Lives here because it is the shop's own voice to its customers, and a new
 * file under api/ would cost a serverless function. The appointment in it is
 * a sample: tomorrow at 10, the shop's first service and stylist, and a price
 * only if the shop has set one, so the preview never shows a made-up figure.
 */
async function sampleAppt(tenant) {
  const [svc, sty] = await Promise.all([
    // duration_min as well as the price: without it the sample has no length,
    // so the preview drops the "How long" row and the add-to-calendar link,
    // and staff read a message missing two things a guest actually receives.
    query(`SELECT name, price_cents, duration_min FROM services
            WHERE tenant_id = $1 AND active ORDER BY sort_order LIMIT 1`, [tenant.id]),
    query(`SELECT name FROM stylists WHERE tenant_id = $1 AND active
            ORDER BY sort_order LIMIT 1`, [tenant.id]),
  ]);
  const start = DateTime.now().setZone(tenant.timezone || 'America/New_York')
    .plus({ days: 1 }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
  return {
    guest_name: 'Jamie Sample',
    guest_email: 'jamie@example.com',
    service_name: svc.rows[0]?.name || 'Your service',
    stylist_name: sty.rows[0]?.name || 'Your stylist',
    price_cents: svc.rows[0]?.price_cents ?? null,
    duration_min: svc.rows[0]?.duration_min ?? 60,
    starts_at: start.toJSDate(),
    ref: 'SAMPLE',
    manage_token: 'preview',
  };
}

/** The welcome as a new team member gets it, with sample details and a placeholder for the link. */
async function previewTeamInvite(tenant, kind = INVITE_KIND) {
  // The reminder previews as the one with a fresh link, the commoner case.
  const stage = kind === INVITE_REMINDER_KIND ? 'invite' : null;
  const sample = { name: 'Jamie Sample', email: 'jamie@example.com', expiresDays: 7, invitedBy: null, stage };
  const out = previewInvite(sample, tenant);
  const { rows } = await query(
    "SELECT to_jsonb(tenants) ->> 'karen_phone' AS karen_phone FROM tenants WHERE id = $1::uuid", [tenant.id],
  );
  return {
    kind, to: `${sample.name} <${sample.email}>`, ...out,
    sms: {
      from: `Karen from ${tenant.name || 'the salon'}`,
      number: prettyPhone(rows[0]?.karen_phone),
      to: sample.name,
      toPhone: '(813) 555-0142',
      body: inviteText({ salon: tenant.name || 'the salon', name: sample.name, link: 'https://app.synergysalon.com/invite?t=...', expiresDays: 7, stage }),
      connected: Boolean(rows[0]?.karen_phone && process.env.TWILIO_AUTH_TOKEN),
    },
  };
}

async function preview(kind, tenant) {
  if (TEAM_KINDS.includes(kind)) return previewTeamInvite(tenant, kind);
  if (!MESSAGE_KINDS.includes(kind)) throw new HttpError(404, 'No such message.');
  const appt = await sampleAppt(tenant);
  const start = DateTime.fromJSDate(appt.starts_at);
  const out = previewMessage(kind, appt, tenant, start.minus({ days: 1 }).toJSDate());
  // The text that goes with it, where there is one: from Karen at the
  // salon's connected number (Settings, Karen AI), to the client's phone.
  const body = smsText(kind, appt, tenant);
  let sms = null;
  if (body) {
    const { rows } = await query(
      "SELECT to_jsonb(tenants) ->> 'karen_phone' AS karen_phone FROM tenants WHERE id = $1::uuid", [tenant.id],
    );
    sms = {
      from: `Karen from ${tenant.name || 'the salon'}`,
      number: prettyPhone(rows[0]?.karen_phone),
      to: appt.guest_name,
      toPhone: '(813) 555-0142',   // a 555 number: a sample, like Jamie
      body,
      connected: Boolean(rows[0]?.karen_phone && process.env.TWILIO_AUTH_TOKEN),
    };
  }
  return { kind, to: `${appt.guest_name} <${appt.guest_email}>`, ...out, sms };
}

/**
 * GET ?sent=<id>: one email from Email history, for the window a row opens
 * (asked for 2026-10-23).
 *
 * The log records who was sent which message and when, not the email itself,
 * so it is rendered again by the code that sends it, from the booking as it
 * is now, and the console says so: a booking moved since shows its new time.
 * The manage link carries a dummy token, never the guest's own, so this
 * window cannot hand anybody a working link into a client's booking. A
 * booking deleted since gets the sample's details under the client's name.
 */
export async function sentMessage(id, tenant) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new HttpError(404, 'No such email.');
  const { rows } = await query(
    `SELECT m.kind, m.to_name, m.to_email, m.sent_at,
            to_jsonb(m) ->> 'subject' AS subject,
            COALESCE(to_jsonb(m) ->> 'status', 'sent') AS status, to_jsonb(m) ->> 'error' AS error,
            to_jsonb(m) ->> 'body' AS body,
            a.ref, a.starts_at, a.duration_min, a.price_cents,
            ${visitNameSql()} AS service_name, ${visitLinesSql()} AS lines, s.name AS stylist_name
       FROM message_sends m
       LEFT JOIN appointments a ON a.id = m.appointment_id
       LEFT JOIN services v ON v.id = a.service_id
       LEFT JOIN stylists s ON s.id = a.stylist_id
      WHERE m.tenant_id = $1 AND m.id = $2::uuid`,
    [tenant.id, id],
  );
  const r = rows[0];
  // An email the team wrote from a client's profile (2026-10-31): shown from
  // the words it was sent with, which the log keeps (039).
  if (r?.kind === 'direct') {
    let kept = {};
    try { kept = JSON.parse(r.body || '{}'); } catch { /* an unreadable row shows empty */ }
    const out = previewStaffEmail({ subject: r.subject || '', text: kept.text || '', toName: r.to_name, fromName: kept.fromName }, tenant);
    return {
      kind: 'direct', sentAt: r.sent_at, toName: r.to_name || r.to_email,
      to: r.to_name ? `${r.to_name} <${r.to_email}>` : r.to_email, ref: null, ...out,
      status: r.status === 'failed' ? 'failed' : 'sent', error: r.status === 'failed' ? r.error || null : null,
    };
  }
  // A team member's welcome (2026-11-04): rebuilt from the facts it was
  // written from, which the log keeps. The setup link is a credential and
  // was never kept, so the button carries a placeholder.
  if (TEAM_KINDS.includes(r?.kind)) {
    let kept = {};
    try { kept = JSON.parse(r.body || '{}'); } catch { /* an unreadable row shows the bare welcome */ }
    const out = previewInvite({ name: r.to_name || kept.name, email: r.to_email, ...kept }, tenant);
    return {
      kind: r.kind, sentAt: r.sent_at, toName: r.to_name || r.to_email,
      to: r.to_name ? `${r.to_name} <${r.to_email}>` : r.to_email, ref: null, ...out,
      subject: r.subject || out.subject,
      status: r.status === 'failed' ? 'failed' : 'sent', error: r.status === 'failed' ? r.error || null : null,
      // A reminder to finish setting up carries only the app's address,
      // which is kept; the others' setup link never is.
      note: kept.stage === 'finish' ? null
        : 'Their setup link is not kept here, because anyone holding it could set up the account. The button stands in for it.',
    };
  }
  if (!r || !MESSAGE_KINDS.includes(r.kind)) throw new HttpError(404, 'No such email.');
  const name = r.to_name || r.to_email;
  const appt = r.ref
    ? {
      service_name: r.service_name || 'Your appointment',
      lines: r.lines,
      stylist_name: r.stylist_name || 'your stylist',
      price_cents: r.price_cents ?? null,
      duration_min: r.duration_min ?? null,
      starts_at: r.starts_at,
      ref: r.ref,
    }
    : await sampleAppt(tenant);
  Object.assign(appt, { guest_name: name, guest_email: r.to_email, manage_token: 'preview' });
  const out = previewMessage(r.kind, appt, tenant);
  return {
    kind: r.kind,
    sentAt: r.sent_at,
    toName: name,
    to: r.to_name ? `${r.to_name} <${r.to_email}>` : r.to_email,
    ref: r.ref || null,
    ...out,
    // The subject as it was sent, where the log kept it (037), and whether
    // it went: the same as the client's Activity says.
    subject: r.subject || out.subject,
    status: r.status === 'failed' ? 'failed' : 'sent',
    error: r.status === 'failed' ? r.error || null : null,
    // That a sent email is rebuilt from its booking is said once, by the
    // info button on Email History's header (2026-10-30), not in every
    // email's window. A deleted booking still says so: its details are a
    // sample, which the header's note does not cover.
    note: r.ref
      ? null
      : 'The booking has since been deleted, so the details below are a sample. The rest is the message that was sent.',
  };
}

/**
 * How many of each message have gone out, and whether the automation is on.
 *
 * Counts start the day migration 024 ran: nothing recorded a send before it,
 * so there is nothing honest to backfill from. The whole thing degrades to
 * zeroes when that migration has not run yet, because this is a number on a
 * screen and not worth taking Marketing down over.
 */
async function automations(tenant, user = null) {
  // Anyone but the owner sees each automation as it is for their own
  // clients (2026-11-04): on only when the salon has it on and they have not
  // switched it off for themselves (048). The team's own automation is not
  // theirs to see.
  const owner = !user || seesAll(user);
  let mine = [];
  if (!owner) {
    const { rows } = await query(
      "SELECT COALESCE(to_jsonb(u) -> 'automations_off', '[]'::jsonb) AS off FROM staff_users u WHERE id = $1::uuid", [user.id],
    ).catch(() => ({ rows: [] }));
    mine = Array.isArray(rows[0]?.off) ? rows[0].off : [];
  }
  const counts = await query(
    `SELECT kind, count(*)::int AS sent, max(sent_at) AS last_sent
       FROM message_sends
      -- What went out: a send the provider refused is logged (037), not sent.
      WHERE tenant_id = $1 AND COALESCE(to_jsonb(message_sends) ->> 'status', 'sent') = 'sent'
      GROUP BY kind`,
    [tenant.id],
  ).catch(() => ({ rows: [] }));

  const by = new Map(counts.rows.map((r) => [r.kind, r]));
  return {
    kinds: (owner ? AUTOMATION_KINDS : MESSAGE_KINDS).map((kind) => ({
      kind,
      on: automationOn(kind, tenant) && !mine.includes(kind),
      salonOn: automationOn(kind, tenant),
      mineOff: mine.includes(kind),
      sent: owner ? (by.get(kind)?.sent ?? 0) : null,
      lastSent: owner ? (by.get(kind)?.last_sent ?? null) : null,
    })),
  };
}

/**
 * Who received one of them, newest first.
 *
 * The name and address come off the log row rather than a join back to the
 * contact, because this answers "who did we email", which is a fact about the
 * past: a guest who has since changed their address, or been deleted, still
 * received it.
 */
async function recipients(kind, tenant) {
  if (!MESSAGE_KINDS.includes(kind)) throw new HttpError(404, 'No such message.');
  const { rows } = await query(
    `SELECT m.to_name, m.to_email, m.sent_at, a.ref
       FROM message_sends m
       LEFT JOIN appointments a ON a.id = m.appointment_id
      WHERE m.tenant_id = $1 AND m.kind = $2
      ORDER BY m.sent_at DESC LIMIT 200`,
    [tenant.id, kind],
  ).catch(() => ({ rows: [] }));
  return {
    kind,
    people: rows.map((r) => ({
      name: r.to_name || r.to_email,
      email: r.to_email,
      sentAt: r.sent_at,
      ref: r.ref || null,
    })),
  };
}

/**
 * GET ?history=1[&before=<cursor>]: every email the automations have sent,
 * newest first, a page at a time, for the history under Marketing.
 *
 * From the send log, so it lists what was sent: one whose automation was
 * switched off was never recorded, and since 037 one the provider refused
 * is, marked failed (as on the client's Activity).
 * The log starts the day migration 024 ran; there is nothing earlier to show.
 *
 * Paged by (sent_at, id) rather than by time alone, so two emails sent in the
 * same instant are neither skipped nor shown twice at a page boundary. The
 * cursor carries sent_at as Postgres's own text, microseconds included: a
 * JavaScript Date would round it to the millisecond and lose rows.
 */
const HISTORY_PAGE = 50;
export async function history(tenant, cursor, { kind = null, q = null, chair = null, userId = null } = {}) {
  const [at, id] = String(cursor || '').split('|');
  const after = at && id && !Number.isNaN(Date.parse(at)) && /^[0-9a-f-]{36}$/i.test(id);
  // The Email history module's filters (2026-10-23): one kind of message,
  // and a name or address. % and _ are escaped so they match themselves.
  const search = q ? String(q).trim().slice(0, 80).replace(/[\\%_]/g, '\\$&') : '';
  const { rows } = await query(
    `SELECT m.id, m.kind, m.to_name, m.to_email, m.sent_at, m.sent_at::text AS at, a.ref,
            to_jsonb(m) ->> 'subject' AS subject,
            COALESCE(to_jsonb(m) ->> 'status', 'sent') AS status
       FROM message_sends m
       LEFT JOIN appointments a ON a.id = m.appointment_id
       LEFT JOIN contacts c ON c.id = COALESCE((to_jsonb(m) ->> 'contact_id')::uuid, a.contact_id)
      WHERE m.tenant_id = $1
        AND ${mineSql('m', 'a', 'c', '$7', '$8')}
        AND ($7::uuid[] IS NULL OR m.kind NOT IN ('team_invite', 'team_invite_reminder'))
        AND ($2::timestamptz IS NULL OR (m.sent_at, m.id) < ($2::timestamptz, $3::uuid))
        AND ($5::text IS NULL OR m.kind = $5::text)
        AND ($6::text = '' OR m.to_name ILIKE '%' || $6::text || '%' OR m.to_email ILIKE '%' || $6::text || '%')
      ORDER BY m.sent_at DESC, m.id DESC
      LIMIT $4::int`,
    [tenant.id, after ? at : null, after ? id : null, HISTORY_PAGE + 1,
      kind ? String(kind).slice(0, 40) : null, search, chair ? chair.ids : null, userId],
  ).catch(() => ({ rows: [] }));
  const page = rows.slice(0, HISTORY_PAGE);
  const last = page[page.length - 1];
  return {
    sends: page.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.to_name || r.to_email,
      email: r.to_email,
      sentAt: r.sent_at,
      ref: r.ref || null,
      subject: r.subject || null,
      // A send the provider refused is on the log too (037), marked.
      status: r.status === 'failed' ? 'failed' : 'sent',
    })),
    next: rows.length > HISTORY_PAGE && last ? `${last.at}|${last.id}` : null,
  };
}

/**
 * GET ?sends=<kind,kind>[&before=<cursor>]: who one automation reached, by
 * email and by text, newest first (asked for 2026-11-02, under the
 * automation's flow). An automation is one or more message kinds (no-show
 * has two), and the appointment texts are logged under the same kind as
 * their email (client_texts, 039), so both lists are read by kind and
 * merged.
 *
 * Paged by time: the cursor is the last row's time as Postgres's own text,
 * microseconds included, so nothing is skipped at a page's edge. Before
 * client_texts exists there are simply no texts.
 */
const SENDS_PAGE = 40;

/**
 * SQL for "this message is about one of my clients" (2026-11-04, scope.js):
 * a visit in their chair, or, with no visit, a client in their book. $chair
 * is the chair's ids (NULL: the owner, everything) and $user their id.
 */
const mineSql = (m, a, c, chair, user) => `(${chair}::uuid[] IS NULL
  OR (${a}.id IS NOT NULL AND ${a}.stylist_id = ANY(${chair}::uuid[]))
  OR (${a}.id IS NULL AND ${c}.id IS NOT NULL AND ${clientInChairSql(c, chair, user)}))`;
export async function automationSends(tenant, kindsParam, cursor, { chair = null, userId = null } = {}) {
  const kinds = String(kindsParam || '').split(',').map((k) => k.trim())
    .filter((k) => (chair ? MESSAGE_KINDS : AUTOMATION_KINDS).includes(k));
  if (!kinds.length) throw new HttpError(404, 'No such automation.');
  const before = cursor && !Number.isNaN(Date.parse(cursor)) ? cursor : null;
  const [emails, texts, teamTexts] = await Promise.all([
    query(
      `SELECT m.id::text AS id, m.kind, m.to_name AS name, m.to_email AS addr, m.sent_at AS at, m.sent_at::text AS at_text,
              COALESCE(to_jsonb(m) ->> 'status', 'sent') AS status, to_jsonb(m) ->> 'error' AS error,
              to_jsonb(m) ->> 'contact_id' AS contact_id
         FROM message_sends m
         LEFT JOIN appointments a ON a.id = m.appointment_id
         LEFT JOIN contacts c ON c.id = COALESCE((to_jsonb(m) ->> 'contact_id')::uuid, a.contact_id)
        WHERE m.tenant_id = $1::uuid AND m.kind = ANY($2::text[])
          AND ${mineSql('m', 'a', 'c', '$5', '$6')}
          AND ($3::timestamptz IS NULL OR m.sent_at < $3::timestamptz)
        ORDER BY m.sent_at DESC
        LIMIT $4::int`,
      [tenant.id, kinds, before, SENDS_PAGE + 1, chair ? chair.ids : null, userId],
    ).catch(() => ({ rows: [] })),
    query(
      `SELECT t.id::text AS id, t.kind, c.name, t.phone AS addr, t.created_at AS at, t.created_at::text AS at_text,
              t.status, t.error, t.contact_id::text AS contact_id
         FROM client_texts t
         LEFT JOIN contacts c ON c.id = t.contact_id
        WHERE t.tenant_id = $1::uuid AND t.kind = ANY($2::text[]) AND t.direction = 'out'
          AND ($5::uuid[] IS NULL OR (c.id IS NOT NULL AND ${clientInChairSql('c', '$5', '$6')}))
          AND ($3::timestamptz IS NULL OR t.created_at < $3::timestamptz)
        ORDER BY t.created_at DESC
        LIMIT $4::int`,
      [tenant.id, kinds, before, SENDS_PAGE + 1, chair ? chair.ids : null, userId],
    ).catch(() => ({ rows: [] })),
    // Texts to the team (046): the invitation's welcome text.
    query(
      `SELECT t.id::text AS id, t.kind, t.to_name AS name, t.phone AS addr, t.created_at AS at, t.created_at::text AS at_text,
              t.status, t.error, NULL::text AS contact_id
         FROM team_texts t
        WHERE t.tenant_id = $1::uuid AND t.kind = ANY($2::text[])
          AND $5::boolean
          AND ($3::timestamptz IS NULL OR t.created_at < $3::timestamptz)
        ORDER BY t.created_at DESC
        LIMIT $4::int`,
      [tenant.id, kinds, before, SENDS_PAGE + 1, !chair],
    ).catch(() => ({ rows: [] })),
  ]);
  const all = [
    ...emails.rows.map((r) => ({ ...r, channel: 'email' })),
    ...texts.rows.map((r) => ({ ...r, channel: 'sms' })),
    ...teamTexts.rows.map((r) => ({ ...r, channel: 'sms' })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at) || b.at_text.localeCompare(a.at_text));
  const page = all.slice(0, SENDS_PAGE);
  const last = page[page.length - 1];
  return {
    sends: page.map((r) => ({
      id: r.id,
      channel: r.channel,
      kind: r.kind,
      name: r.name || null,
      // The address it went to: an email address, or a phone number.
      to: r.channel === 'sms' ? (prettyPhone(r.addr) || r.addr) : r.addr,
      at: r.at,
      status: r.status === 'failed' ? 'failed' : 'sent',
      error: r.status === 'failed' ? (r.error || null) : null,
      contactId: r.contact_id || null,
    })),
    next: all.length > SENDS_PAGE && last ? last.at_text : null,
  };
}

/**
 * GET ?finance=1[&from=YYYY-MM-DD&to=YYYY-MM-DD]: what the salon's visits
 * were worth over a period, in total and by stylist, for Marketing, Finance.
 *
 * The app records no payments yet (nothing does until Stripe), so this is
 * the value of the visits, not money received, and the console says so.
 * Counted exactly as Home counts value: a visit is kept unless it was
 * cancelled or a no-show, and it is worth the price booked on it, else its
 * service's. Visits with neither are counted and named, never guessed.
 * Past visits are "earned"; the rest of the period is "booked ahead".
 *
 * Owners, admins and managers only: what each stylist brings in is not for
 * the whole team. The period defaults to this month on the salon's clock.
 */
export async function finance(tenant, fromParam, toParam, now = new Date(), chairIds = null) {
  const zone = tenant.timezone || 'America/New_York';
  const today = DateTime.fromJSDate(now).setZone(zone);
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const from = (isDate(fromParam) ? DateTime.fromISO(fromParam, { zone }) : today).startOf(isDate(fromParam) ? 'day' : 'month');
  const to = (isDate(toParam) ? DateTime.fromISO(toParam, { zone }) : today).endOf(isDate(toParam) ? 'day' : 'month');
  if (!from.isValid || !to.isValid || to < from) throw new HttpError(400, 'Those dates are not valid.');
  if (to.diff(from, 'days').days > 400) throw new HttpError(400, 'Pick a period of a year or less.');

  const { rows } = await query(
    `SELECT s.id, s.name,
            count(*) FILTER (WHERE a.starts_at < $4::timestamptz)::int AS visits,
            COALESCE(sum(COALESCE(a.price_cents, v.price_cents))
                     FILTER (WHERE a.starts_at < $4::timestamptz), 0)::bigint AS earned,
            count(*) FILTER (WHERE a.starts_at < $4::timestamptz
                              AND a.price_cents IS NULL AND v.price_cents IS NULL)::int AS unpriced,
            count(*) FILTER (WHERE a.starts_at >= $4::timestamptz)::int AS ahead_visits,
            COALESCE(sum(COALESCE(a.price_cents, v.price_cents))
                     FILTER (WHERE a.starts_at >= $4::timestamptz), 0)::bigint AS ahead,
            count(*) FILTER (WHERE a.starts_at >= $4::timestamptz
                              AND a.price_cents IS NULL AND v.price_cents IS NULL)::int AS ahead_unpriced
       FROM appointments a
       JOIN stylists s ON s.id = a.stylist_id
       JOIN services v ON v.id = a.service_id
      WHERE a.tenant_id = $1 AND a.starts_at >= $2::timestamptz AND a.starts_at <= $3::timestamptz
        AND a.status::text NOT IN ('cancelled', 'no_show')
        -- A stylist's own chair only, for their own Money (2026-11-04).
        AND ($5::uuid[] IS NULL OR a.stylist_id = ANY($5::uuid[]))
      GROUP BY s.id, s.name
      ORDER BY earned DESC, s.name`,
    [tenant.id, from.toISO(), to.toISO(), now.toISOString(), chairIds],
  );
  const stylists = rows.map((r) => ({
    name: r.name,
    visits: r.visits,
    earnedCents: Number(r.earned),
    unpriced: r.unpriced,
    aheadVisits: r.ahead_visits,
    aheadCents: Number(r.ahead),
    aheadUnpriced: r.ahead_unpriced,
  }));
  const sum = (k) => stylists.reduce((n, s) => n + s[k], 0);
  return {
    from: from.toISODate(),
    to: to.toISODate(),
    total: {
      visits: sum('visits'), earnedCents: sum('earnedCents'), unpriced: sum('unpriced'),
      aheadVisits: sum('aheadVisits'), aheadCents: sum('aheadCents'), aheadUnpriced: sum('aheadUnpriced'),
    },
    stylists,
  };
}

/**
 * Cash-out requests (048, asked for 2026-11-04): a stylist asks to be paid
 * out; the owner pays it however the salon pays its team and marks it paid
 * or declined. The app moves no money. The owner sees everyone's, anybody
 * else their own.
 */
export async function cashouts(tenant, user) {
  const owner = seesAll(user);
  const { rows } = await query(
    `SELECT r.id, r.staff_user_id, r.staff_name, r.amount_cents, r.note, r.status, r.created_at, r.decided_at,
            d.name AS decided_by_name
       FROM cashout_requests r LEFT JOIN staff_users d ON d.id = r.decided_by
      WHERE r.tenant_id = $1::uuid AND ($2::uuid IS NULL OR r.staff_user_id = $2::uuid)
      ORDER BY (r.status = 'requested') DESC, r.created_at DESC
      LIMIT 100`,
    [tenant.id, owner ? null : user.id],
  ).catch((err) => { if (err.code === '42P01') return { rows: [] }; throw err; });
  return {
    canDecide: owner,
    requests: rows.map((r) => ({
      id: r.id, name: r.staff_name, mine: String(r.staff_user_id) === String(user.id),
      amountCents: r.amount_cents, note: r.note || '', status: r.status, at: r.created_at,
      decidedAt: r.decided_at, decidedBy: r.decided_by_name || null,
    })),
  };
}

async function requestCashout(req, tenant, user, body) {
  const amount = Math.round(Number(body.amount) * 100);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) {
    throw new HttpError(400, 'Type the amount in dollars, like 250 or 250.50.');
  }
  const note = String(body.note || '').trim().slice(0, 300);
  const { rows } = await query(
    `INSERT INTO cashout_requests (tenant_id, staff_user_id, staff_name, amount_cents, note)
     VALUES ($1::uuid, $2::uuid, $3::text, $4::int, NULLIF($5::text, '')) RETURNING id`,
    [tenant.id, user.id, user.name || user.email, amount, note],
  );
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  const appUrl = host ? `https://${host}${host.startsWith('app.') ? '' : '/staff'}/settings` : null;
  // Told by email; the request is in Money either way.
  try {
    await sendCashoutNotice({ name: user.name || user.email, amountCents: amount, note, appUrl }, tenant);
  } catch (err) {
    console.error('cash-out notice failed', err.message);
  }
  return { id: rows[0].id };
}

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);
    const q = new URL(req.url, 'http://localhost').searchParams;
    const kind = q.get('preview');
    if (kind) return json(res, 200, await preview(kind, tenant));
    // The email and text logs, the automations' sends and Finance are every
    // client's and every chair's: the owner's only (asked for 2026-11-03,
    // scope.js). A template's preview, with sample details, is anyone's.
    // Everything here but one sent email is Salon Settings or the whole
    // salon's (2026-11-03): the salon's profile, the automations and their
    // previews and sends, the email log and Finance. The owner's only.
    // Since 2026-11-04 anyone sees their own share of the automations,
    // their sends, their Money and their cash-outs (scoped below); the
    // salon's profile stays the owner's.
    const ownView = ['sent', 'automations', 'sends', 'history', 'finance', 'cashouts'].some((k) => q.has(k));
    if (!ownView && !seesAll(user)) {
      throw new HttpError(403, 'Only the salon owner can see the salon settings.');
    }
    const chair = await chairOf(user);
    const scope = { chair, userId: user.id };
    // One sent email opens for anyone whose client it was sent to (their
    // client's Activity links it); nobody else's.
    if (q.has('sent') && !seesAll(user)) {
      const { rows } = await query(
        `SELECT COALESCE(to_jsonb(m) ->> 'contact_id', a.contact_id::text) AS contact_id
           FROM message_sends m LEFT JOIN appointments a ON a.id = m.appointment_id
          WHERE m.id::text = $1::text AND m.tenant_id = $2::uuid`,
        [String(q.get('sent')), tenant.id],
      ).catch(() => ({ rows: [] }));
      if (!rows[0]?.contact_id) throw new HttpError(404, 'That email is not on record.');
      await assertClientInChair(user, rows[0].contact_id, await chairOf(user));
    }
    if (q.has('sent')) return json(res, 200, await sentMessage(q.get('sent'), tenant));
    if (q.has('automations')) return json(res, 200, await automations(tenant, user));
    if (q.has('sends')) return json(res, 200, await automationSends(tenant, q.get('sends'), q.get('before'), scope));
    if (q.has('history')) {
      return json(res, 200, await history(tenant, q.get('before'), { kind: q.get('kind'), q: q.get('q'), ...scope }));
    }
    if (q.has('cashouts')) return json(res, 200, await cashouts(tenant, user));
    if (q.has('finance')) {
      // Owners, admins and managers see the salon's; anybody else their own
      // chair's (2026-11-04). Somebody with no chair has nothing to show.
      const salon = CAN_EDIT.includes(user.role) || seesAll(user);
      const ids = salon ? null : (chair ? chair.ids : []);
      return json(res, 200, { ...(await finance(tenant, q.get('from'), q.get('to'), new Date(), ids)), own: !salon });
    }
    const who = q.get('recipients');
    if (who) return json(res, 200, await recipients(who, tenant));
    const { rows } = await query(
      `SELECT name, slug, logo, address, phone, email, website, about, timezone,
              host, app_host, to_jsonb(tenants) ->> 'reply_to' AS reply_to,
              -- Through to_jsonb, so Settings still loads before migration 026.
              to_jsonb(tenants) ->> 'review_url' AS review_url
         FROM tenants WHERE id = $1`,
      [tenant.id],
    );
    const t = rows[0];
    return json(res, 200, {
      name: t.name,
      slug: t.slug,
      logo: t.logo,
      address: t.address,
      phone: t.phone,
      email: t.email,
      replyTo: t.reply_to || '',
      // Where the review request email sends people. Empty until it is set,
      // and that email is not queued at all while it is empty: asking for a
      // review with nowhere to leave one wastes the one ask you get.
      reviewUrl: t.review_url || '',
      website: t.website,
      about: t.about,
      // Shown, never edited here: an owner should be able to see what their
      // booking link is and what clock the diary runs on without being handed
      // the controls that would break both.
      timezone: t.timezone,
      bookingUrl: t.host ? `https://${t.host}` : `/s/${t.slug}`,
      canEdit: CAN_EDIT.includes(user.role),
    });
  },

  async PATCH(req, res) {
    assertSameOrigin(req);
    const anyone = await requireStaff(req);
    const tenantOf = await tenantForUser(anyone);
    const sent = await readJson(req);
    // A stylist's own switch for their own clients (048, 2026-11-04). The
    // salon's switch stays the owner's, below.
    if (sent.automation !== undefined && !seesAll(anyone)) {
      const kind = String(sent.automation);
      if (!MESSAGE_KINDS.includes(kind)) throw new HttpError(404, 'No such automation.');
      const on = sent.on !== false;
      await query(
        on
          ? 'UPDATE staff_users SET automations_off = array_remove(automations_off, $2::text) WHERE id = $1::uuid'
          : `UPDATE staff_users SET automations_off = (
               SELECT array_agg(DISTINCT k) FROM unnest(automations_off || $2::text) AS k) WHERE id = $1::uuid`,
        [anyone.id, kind],
      );
      return json(res, 200, { automation: kind, on, mine: true });
    }
    // Asking to be paid out, anyone with a login; deciding, the owner.
    if (sent.cashout !== undefined) {
      return json(res, 201, await requestCashout(req, tenantOf, anyone, sent.cashout || {}));
    }
    if (sent.cashoutId !== undefined) {
      if (!seesAll(anyone)) throw new HttpError(403, 'Only the salon owner can settle a cash-out request.');
      const status = sent.status === 'paid' || sent.status === 'declined' ? sent.status : null;
      if (!status) throw new HttpError(400, 'Mark it paid or declined.');
      const { rowCount } = await query(
        `UPDATE cashout_requests SET status = $3::text, decided_by = $4::uuid, decided_at = now()
          WHERE id::text = $1::text AND tenant_id = $2::uuid AND status = 'requested'`,
        [String(sent.cashoutId), tenantOf.id, status, anyone.id],
      );
      if (!rowCount) throw new HttpError(409, 'That request was already settled.');
      return json(res, 200, { ok: true, status });
    }
    const user = await requireStaff(req, CAN_EDIT);
    // Salon Settings are changed by the owner only (2026-11-03).
    if (!seesAll(user)) throw new HttpError(403, 'Only the salon owner can change the salon settings.');
    const tenant = tenantOf;
    const body = sent;

    // Switching an automation on or off, from Marketing. Its own branch and
    // its own reply, because it has nothing to do with the shop's address and
    // the caller is a different screen.
    if (body.automation !== undefined) {
      const kind = String(body.automation);
      if (!AUTOMATION_KINDS.includes(kind)) throw new HttpError(404, 'No such automation.');
      const on = body.on !== false;
      await query(
        on
          ? `UPDATE tenants SET automations_off = array_remove(automations_off, $2) WHERE id = $1`
          : `UPDATE tenants
                SET automations_off = (
                  SELECT array_agg(DISTINCT k) FROM unnest(automations_off || $2::text) AS k)
              WHERE id = $1`,
        [tenant.id, kind],
      );
      return json(res, 200, { automation: kind, on });
    }

    const sets = [];
    const params = [tenant.id];
    const add = (col, value) => { params.push(value); sets.push(`${col} = $${params.length}`); };
    const text = (v, max) => String(v || '').trim().slice(0, max);

    if (body.name !== undefined) add('name', requireString(body.name, 'Business name', { max: 120 }));
    if (body.address !== undefined) add('address', text(body.address, 300));
    if (body.phone !== undefined) add('phone', text(body.phone, 40));
    if (body.email !== undefined) add('email', text(body.email, 254).toLowerCase());
    if (body.about !== undefined) add('about', text(body.about, 1000));
    // Empty is allowed, and means "use the profile email" again.
    if (body.replyTo !== undefined) {
      const to = text(body.replyTo, 254).toLowerCase();
      add('reply_to', to ? requireEmail(to, 'Reply-to email') : null);
    }

    // Emptying it is allowed, and switches the review request back off.
    if (body.reviewUrl !== undefined) {
      const link = text(body.reviewUrl, 400);
      if (link && !/^https:\/\//i.test(link)) {
        throw new HttpError(400, 'A review link must start with https://');
      }
      add('review_url', link || null);
    }

    if (body.website !== undefined) {
      const site = text(body.website, 200);
      // Stored with a scheme so it is a link wherever it is printed, rather
      // than something that resolves relative to whatever page shows it.
      add('website', site && !/^https?:\/\//i.test(site) ? `https://${site}` : site);
    }

    const logo = logoFrom(body.logo);
    if (logo !== undefined) add('logo', logo);

    if (!sets.length) throw new HttpError(400, 'Nothing to change.');

    const { rows } = await query(
      `UPDATE tenants SET ${sets.join(', ')} WHERE id = $1
        RETURNING name, logo, address, phone, email, website, about,
                  COALESCE(reply_to, '') AS "replyTo"`,
      params,
    );
    return json(res, 200, { ...rows[0], saved: true });
  },
});
