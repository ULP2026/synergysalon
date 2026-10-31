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
import { sendText } from './twilio.js';

/** The kinds that are texted. Follow-ups (reviews, rebooking) are not: those read as marketing. */
export const TEXTED_KINDS = ['confirmation', 'reschedule', 'cancellation', 'reminder'];

const first = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/**
 * The text for a kind: Karen introducing herself and the salon first ("Hey!
 * This is Karen from Synergy Salon.", the salon's words, 2026-10-31; it was
 * "Synergy Salon:"), so the sender is known at a glance, the message short,
 * and the way to stop at the end, as the carriers require.
 */
export function appointmentText(kind, appt, tenant = {}) {
  const zone = tenant.timezone || 'America/New_York';
  const at = DateTime.fromJSDate(new Date(appt.starts_at)).setZone(zone);
  const tomorrow = at.hasSame(DateTime.now().setZone(zone).plus({ days: 1 }), 'day');
  const when = `${tomorrow ? 'tomorrow, ' : ''}${at.toFormat("ccc, LLL d 'at' h:mm a")}`;
  const shop = tenant.name || 'The salon';
  const name = first(appt.guest_name);
  const visit = `${appt.service_name || 'appointment'}${appt.stylist_name ? ` with ${first(appt.stylist_name)}` : ''}`;
  const stop = 'Reply STOP to opt out.';
  const hey = `Hey! This is Karen from ${shop}.`;
  const texts = {
    confirmation: `${hey} You're booked${name ? `, ${name}` : ''}! ${visit}, ${when}. Reply here to move or cancel. ${stop}`,
    reschedule: `${hey} Your ${visit} has moved to ${when}. Reply here if that doesn't work. ${stop}`,
    cancellation: `${hey} Your ${visit} for ${when} is cancelled. Reply here any time to book again. ${stop}`,
    reminder: `${hey} Just a reminder${name ? `, ${name}` : ''}: your ${visit} is ${when}. Reply here to reschedule${tenant.phone ? ` or call ${tenant.phone}` : ''}. ${stop}`,
  };
  return texts[kind] || null;
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
    await send({ to: `+1${r.phone}`, from: r.karen_phone, body });
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
