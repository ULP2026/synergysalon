/**
 * Messaging a client from their profile (asked for 2026-10-31): the team
 * writes a text or an email, as they would in the CRM's conversations.
 *
 * A text goes from Karen's number, signed by the person who wrote it
 * ("Luis at Synergy Salon: ..."), and only to a client who has agreed to
 * texts and whose Text messages switch is on: the same rule as the
 * appointment texts (sms-notify.js), which is what the salon's carrier
 * registration promises. Their reply comes back to Karen's number, where
 * Karen answers it, and the whole conversation is on their Activity.
 *
 * An email goes from the salon's sender with replies to the salon's inbox
 * (email.js, sendStaffEmail), and is kept so it can be opened again.
 *
 * Every text with a client, either way, is kept in client_texts (039):
 * these, the appointment texts, and their conversation with Karen.
 */
import { query } from './db.js';
import { HttpError } from './http.js';
import { sendStaffEmail } from './email.js';
import { segments, toGsm } from './sms-length.js';
import { sendText } from './twilio.js';
import { logClientText } from './client-texts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const first = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/**
 * Whether this client can be texted from the profile, and why not. The
 * console shows the reason under the box rather than a Send that fails.
 */
export function textBlock(c, tenant) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return 'Texting is not connected yet.';
  if (!tenant.karen_phone) return "Karen's number is not set up yet (Settings, Karen AI).";
  if (!c.sms_consent_at || !c.sms_consent_phone) {
    return "They haven't agreed to texts yet. They can at synergysalon.com/sms-opt-in, or by texting START to Karen.";
  }
  if (c.sms_ok === 'false') return 'Texts are switched off on their profile.';
  return null;
}

/** Send what the team member wrote. Returns { sent: 'text' | 'email' } or throws an HttpError saying why not. */
export async function messageClient({ tenant, user, contactId, channel, subject, text }, db = null) {
  const q = db?.query ? db.query.bind(db) : query;
  if (!UUID.test(String(contactId || ''))) throw new HttpError(400, 'That client is not valid.');
  const words = String(text || '').trim();
  if (!words) throw new HttpError(400, 'Write a message first.');
  const { rows } = await q(
    `SELECT c.id, c.name, c.email, c.phone,
            to_jsonb(c) ->> 'sms_consent_at' AS sms_consent_at,
            to_jsonb(c) ->> 'sms_consent_phone' AS sms_consent_phone,
            to_jsonb(c) ->> 'sms_ok' AS sms_ok,
            to_jsonb(t) ->> 'karen_phone' AS karen_phone
       FROM contacts c JOIN tenants t ON t.id = c.tenant_id
      WHERE c.id = $1::uuid AND c.tenant_id = $2::uuid`,
    [contactId, tenant.id],
  );
  const c = rows[0];
  if (!c) throw new HttpError(404, 'That client no longer exists.');

  if (channel === 'sms') {
    const why = textBlock(c, { karen_phone: c.karen_phone });
    if (why) throw new HttpError(409, why, 'CANNOT_TEXT');
    // Signed by whoever wrote it, so the client knows it is a person and who.
    const body = toGsm(`${first(user.name) || 'The team'} at ${tenant.name}: ${words}`).slice(0, 612);
    if (segments(body) > 4) throw new HttpError(400, 'That text is too long: keep it to a few sentences.');
    const to = `+1${c.sms_consent_phone}`;
    try {
      await sendText({ to, from: c.karen_phone, body });
    } catch (err) {
      await logClientText(db, { tenantId: tenant.id, contactId: c.id, direction: 'out', kind: 'direct', phone: c.sms_consent_phone, body, sentBy: user.id, status: 'failed', error: err.message });
      console.error('client text not sent', err.message);
      throw new HttpError(502, "The text didn't go through. Try again in a moment.");
    }
    await logClientText(db, { tenantId: tenant.id, contactId: c.id, direction: 'out', kind: 'direct', phone: c.sms_consent_phone, body, sentBy: user.id });
    return { sent: 'text' };
  }

  if (channel === 'email') {
    if (!c.email) throw new HttpError(409, 'There is no email address on file for them.', 'NO_EMAIL');
    const subj = String(subject || '').trim().slice(0, 150);
    if (!subj) throw new HttpError(400, 'Add a subject for the email.');
    try {
      const out = await sendStaffEmail({
        to: c.email, toName: c.name, subject: subj, text: words.slice(0, 5000),
        fromName: `${user.name || 'The team'}, ${tenant.name}`, contactId: c.id,
      }, tenant);
      if (out.skipped) throw new HttpError(503, 'Email is not connected yet.');
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, "The email didn't go through. Try again in a moment.");
    }
    return { sent: 'email' };
  }
  throw new HttpError(400, 'Choose text or email.');
}
