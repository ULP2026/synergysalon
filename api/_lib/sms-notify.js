/**
 * Appointment texts to a client, from Karen's number (asked for 2026-10-28):
 * the confirmation, a move, a cancellation, and the reminder the day before.
 * They go out beside the email of the same kind (email.js, sendMessage), so
 * the Marketing switches and every place that books or changes a visit
 * already reach them.
 *
 * **Only to a client whose consent is on record**: `contacts.sms_consent_at`,
 * set when they tick the box on synergysalon.com/sms-opt-in (or reply START),
 * and cleared when they reply STOP. Not `sms_ok`, which defaults to true and
 * so is not consent. The salon's A2P registration says texts go only to
 * people who opted in that way; texting anybody else breaks what the
 * carriers approved. A "client agreed" box at booking comes later, after the
 * campaign is updated to include it.
 *
 * Never throws: a text is a courtesy on top of a booking that already exists.
 */
import { DateTime } from 'luxon';

import { hasColumn, query } from './db.js';
import { logClientText } from './client-texts.js';
import { fitText } from './sms-length.js';
import { sendText } from './twilio.js';

/** The kinds that are texted. Follow-ups (reviews, rebooking) are not: those read as marketing. */
export const TEXTED_KINDS = ['confirmation', 'reschedule', 'cancellation', 'reminder'];

const first = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/**
 * The text for a kind: Karen introducing herself and the salon first ("Hey!
 * This is Karen from Synergy Salon.", the salon's words, 2026-10-31; it was
 * "Synergy Salon:"), so the sender is known at a glance, and the way to stop
 * at the end, as the carriers require.
 *
 * One segment is the default (2026-10-31): each kind has its wordings from
 * fullest to shortest, and fitText sends the fullest that fits 160 plain
 * characters. Dropped first: the salon's phone, the client's name, the long
 * date, the "reply" line, the stylist. Two segments only when even the
 * shortest is longer (a long service name); a service name is never cut.
 */
export function appointmentText(kind, appt, tenant = {}) {
  const zone = tenant.timezone || 'America/New_York';
  const at = DateTime.fromJSDate(new Date(appt.starts_at)).setZone(zone);
  const tomorrow = at.hasSame(DateTime.now().setZone(zone).plus({ days: 1 }), 'day');
  const time = at.minute ? at.toFormat('h:mm a') : at.toFormat('h a');
  // "tomorrow, Sat, Oct 31 at 2 PM", or "Sat, Oct 31 at 2 PM"; short:
  // "tomorrow at 2 PM", or "Sat 10/31 at 2 PM".
  const long = `${tomorrow ? 'tomorrow, ' : ''}${at.toFormat('ccc, LLL d')} at ${time}`;
  const short = tomorrow ? `tomorrow at ${time}` : `${at.toFormat('ccc M/d')} at ${time}`;
  const shop = tenant.name || 'The salon';
  const name = first(appt.guest_name);
  const service = appt.service_name || 'appointment';
  const withWho = appt.stylist_name ? ` with ${first(appt.stylist_name)}` : '';
  const hey = `Hey! This is Karen from ${shop}.`;
  const stop = 'Reply STOP to opt out.';
  const line = (...parts) => [hey, ...parts.filter(Boolean), stop].join(' ');
  const hi = (word) => (name ? `${word}, ${name}` : word);

  const versions = {
    confirmation: [
      line(`${hi("You're booked")}! ${service}${withWho}, ${long}.`, 'Reply to move or cancel.'),
      line(`You're booked! ${service}${withWho}, ${long}.`, 'Reply to move or cancel.'),
      line(`You're booked! ${service}${withWho}, ${short}.`, 'Reply to change it.'),
      line(`You're booked! ${service}${withWho}, ${short}.`),
      line(`You're booked! ${service}, ${short}.`),
    ],
    reschedule: [
      line(`Your ${service}${withWho} is now ${long}.`, "Reply if that doesn't work."),
      line(`Your ${service}${withWho} is now ${short}.`, "Reply if that doesn't work."),
      line(`Your ${service}${withWho} is now ${short}.`),
      line(`Your ${service} is now ${short}.`),
    ],
    cancellation: [
      line(`Your ${service}${withWho} for ${long} is cancelled.`, 'Reply anytime to rebook.'),
      line(`Your ${service}${withWho} for ${short} is cancelled.`, 'Reply to rebook.'),
      line(`Your ${service}${withWho} for ${short} is cancelled.`),
      line(`Your ${service} for ${short} is cancelled.`),
    ],
    reminder: [
      line(`${hi('Reminder')}: your ${service}${withWho} is ${long}.`, `Reply to reschedule${tenant.phone ? ` or call ${tenant.phone}` : ''}.`),
      line(`${hi('Reminder')}: your ${service}${withWho} is ${long}.`, 'Reply to reschedule.'),
      line(`Reminder: your ${service}${withWho} is ${long}.`, 'Reply to reschedule.'),
      line(`Reminder: your ${service}${withWho} is ${short}.`, 'Reply to reschedule.'),
      line(`Reminder: your ${service}${withWho} is ${short}.`),
      line(`Reminder: your ${service} is ${short}.`),
    ],
  };
  return versions[kind] ? fitText(versions[kind]) : null;
}

/**
 * Text the client of `appt` about `kind`, if they have agreed to texts and
 * the salon's number is connected. Returns what happened, for logs and tests.
 */
export async function textGuest(kind, appt, tenant = {}, { send = sendText, db = { query } } = {}) {
  if (!TEXTED_KINDS.includes(kind) || !tenant?.id || !appt?.contact_id) return { skipped: 'not texted' };
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return { skipped: 'texting not connected' };
  try {
    const { rows } = await db.query(
      `SELECT to_jsonb(c) ->> 'sms_consent_at' AS consent_at,
              to_jsonb(c) ->> 'sms_consent_phone' AS phone,
              to_jsonb(c) ->> 'sms_ok' AS sms_ok,
              to_jsonb(t) ->> 'karen_phone' AS karen_phone,
              t.name, t.phone AS salon_phone
         FROM contacts c JOIN tenants t ON t.id = c.tenant_id
        WHERE c.id = $1::uuid AND c.tenant_id = $2::uuid`,
      [appt.contact_id, tenant.id],
    );
    const r = rows[0];
    if (!r?.consent_at || !r.phone) return { skipped: 'no consent' };
    // The salon turned texts off for this client on their profile: never
    // texted, even with consent on record.
    if (r.sms_ok === 'false') return { skipped: 'switched off' };
    if (!r.karen_phone) return { skipped: 'no number' };
    const body = appointmentText(kind, appt, { ...tenant, name: tenant.name || r.name, phone: tenant.phone || r.salon_phone });
    try {
      await send({ to: `+1${r.phone}`, from: r.karen_phone, body });
    } catch (err) {
      await logClientText(db, { tenantId: tenant.id, contactId: appt.contact_id, direction: 'out', kind, phone: r.phone, body, status: 'failed', error: err.message });
      throw err;
    }
    // On the client's Activity, under SMS (2026-10-31).
    await logClientText(db, { tenantId: tenant.id, contactId: appt.contact_id, direction: 'out', kind, phone: r.phone, body });
    return { texted: true };
  } catch (err) {
    // Until the carriers approve the number every send is refused, and a
    // client who replied STOP is refused by Twilio too: logged, never fatal.
    console.error('appointment text not sent', kind, appt.ref, err.message);
    return { failed: true };
  }
}

/**
 * The columns this needs, if the database has them: 034 (consent) comes
 * through ensure-schema, but sms_ok is 031, which production may not have
 * run. Without 034 nothing is recorded, and nothing is texted either.
 */
async function consentColumns() {
  return { consent: await hasColumn('contacts', 'sms_consent_at'), ok: await hasColumn('contacts', 'sms_ok') };
}

/** The texting consent on record for this number, as the contact form or a START reply leaves it. */
export async function recordConsent(db, tenantId, phone10, source) {
  const cols = await consentColumns();
  if (!phone10 || !cols.consent) return 0;
  const { rowCount } = await db.query(
    `UPDATE contacts
        SET sms_consent_at = now(), sms_consent_source = $3::text, sms_consent_phone = $2::text
            ${cols.ok ? ', sms_ok = true' : ''}
      WHERE tenant_id = $1::uuid AND right(regexp_replace(phone, '\\D', '', 'g'), 10) = $2::text`,
    [tenantId, phone10, source],
  );
  return rowCount;
}

/** STOP: no more texts to this number, whoever it belongs to. */
export async function revokeConsent(db, tenantId, phone10) {
  const cols = await consentColumns();
  if (!phone10 || !cols.consent) return 0;
  const { rowCount } = await db.query(
    `UPDATE contacts
        SET sms_consent_at = NULL, sms_consent_source = 'Replied STOP'
            ${cols.ok ? ', sms_ok = false' : ''}
      WHERE tenant_id = $1::uuid
        AND (sms_consent_phone = $2::text OR right(regexp_replace(phone, '\\D', '', 'g'), 10) = $2::text)`,
    [tenantId, phone10],
  );
  return rowCount;
}

/**
 * The welcome text Karen sends somebody invited to the team (2026-11-03;
 * reworded 2026-11-04 as Karen introducing herself), so they can set up
 * their account on their phone. From Karen's number, who leads the setup. A
 * team member is not a client, so the client-consent rules above do not
 * apply: the owner who invites them enters the number for exactly this.
 * Plain characters only (GSM-7), so the link and all fit two segments.
 */
export function inviteText({ salon, name, link, expiresDays, stage = null }) {
  const first = String(name || '').trim().split(/\s+/)[0];
  const hi = `Hi${first ? ` ${first}` : ''}! `;
  // Karen's reminders (2026-11-04), sent by the owner's Resend Invitation.
  if (stage === 'finish') {
    return `${hi}It's Karen from ${salon}, just a friendly reminder: your account setup isn't finished yet. `
      + `Sign in and I'll pick up right where you left off: ${link}`;
  }
  if (stage === 'invite') {
    return `${hi}It's Karen from ${salon}, just a friendly reminder that your invitation is waiting. `
      + `Here's a fresh link (the old one no longer works): ${link} (works ${expiresDays || 7} days, just for you)`;
  }
  return `${hi}I'm Karen, the assistant at ${salon}. You're invited to join the team! `
    + `Tap to choose your password and I'll walk you through your profile: ${link} `
    + `(link works ${expiresDays || 7} days, just for you)`;
}

/** Keep a text to the team (046). Never throws; a missing table is fine. */
async function logTeamText(db, row) {
  try {
    await db.query(
      `INSERT INTO team_texts (tenant_id, staff_user_id, kind, to_name, phone, body, status, error)
       VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text)`,
      [row.tenantId, row.staffUserId || null, row.kind, row.name || null, row.phone, row.body, row.status,
        row.error ? String(row.error).slice(0, 500) : null],
    );
  } catch (err) {
    if (err.code !== '42P01') console.warn('team text not logged', err.message);
  }
}

/**
 * Text the welcome. Logged in team_texts with the link taken out (it is a
 * credential), sent or failed, for the automation's Sent History. Never
 * throws: the email and the link on the owner's screen still work when
 * texting does not. Skipped when the owner switched the Team Member
 * Invitation automation off. `send` and `db` are for tests.
 */
export async function textInvite({ tenant, phone, name, link, expiresDays, staffUserId = null, stage = null }, { send = sendText, db = { query } } = {}) {
  const kind = stage ? 'team_invite_reminder' : 'team_invite';
  const digits = String(phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (digits.length !== 10) return { skipped: 'no mobile' };
  if (Array.isArray(tenant?.automations_off) && tenant.automations_off.includes('team_invite')) return { skipped: 'off' };
  if (send === sendText && (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN)) return { skipped: 'texting not connected' };
  let body = '';
  const salonRow = {};
  try {
    const { rows } = await db.query(
      "SELECT name, to_jsonb(t) ->> 'karen_phone' AS karen_phone FROM tenants t WHERE id = $1::uuid", [tenant.id],
    );
    Object.assign(salonRow, rows[0] || {});
    if (!salonRow.karen_phone) return { skipped: 'no number' };
    body = inviteText({ salon: salonRow.name || tenant.name || 'the salon', name, link, expiresDays, stage });
    await send({ to: `+1${digits}`, from: salonRow.karen_phone, body });
  } catch (err) {
    console.error('invite text failed', err.message);
    if (body) {
      await logTeamText(db, { tenantId: tenant.id, staffUserId, kind, name, phone: digits,
        body: body.replace(link, stage === 'finish' ? link : '[setup link]'), status: 'failed', error: err.message });
    }
    return { skipped: 'failed', failed: true };
  }
  await logTeamText(db, { tenantId: tenant.id, staffUserId, kind, name, phone: digits,
    body: body.replace(link, stage === 'finish' ? link : '[setup link]'), status: 'sent' });
  return { texted: true };
}
