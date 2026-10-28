/**
 * The website's contact form (synergysalon.com/sms-opt-in, asked for
 * 2026-10-27): a message for the salon, and the place a guest can agree to
 * appointment texts. It is the opt-in the salon's A2P 10DLC registration
 * describes to the carriers, so the rules here are theirs:
 *
 * - The text box is optional and never ticked for them. Ticking it records
 *   consent; leaving it alone records nothing, and never takes away a
 *   consent the guest gave somewhere else.
 * - Consent needs a number to text, so a ticked box with no mobile number is
 *   refused with a reason, not silently stored.
 * - The proof is kept on the client record: a dated line in their notes
 *   saying where and how they agreed, and `sms_ok` switched on.
 *
 * Reached through POST /api/enquiry with kind "contact", because the project
 * is at Vercel's twelve-function limit.
 */
import { query, transaction, hasColumn } from './db.js';
import { HttpError, requireString } from './http.js';
import { sendText } from './karen-sms.js';

const clean = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** A whole address, or nothing: the same test the booking form uses. */
function emailFrom(value) {
  const s = clean(value, 200).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s) ? s : '';
}

/** Ten digits for a US number (a leading 1 dropped), else nothing. */
function mobileFrom(value) {
  let d = clean(value, 40).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? d : '';
}

/**
 * The text a guest gets the moment they tick the box: what they signed up
 * for, in the words the carriers require of every recurring programme's
 * opt-in confirmation (brand, frequency, rates, HELP, STOP). The A2P
 * registration's message flow says this is sent, and Twilio's own opt-in
 * reply (START) should read the same.
 */
export function optInText(tenant = {}) {
  const shop = tenant.name || 'the salon';
  return `${shop}: You're signed up for appointment texts (reminders, confirmations and replies). `
    + 'Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.';
}

/**
 * Send that confirmation from Karen's number. Nothing is sent without both
 * a number connected in Settings and the provider's keys, and a failure
 * (until the carriers approve the number, every send fails) never loses
 * the message the guest wrote.
 */
export async function sendOptInConfirmation(tenant, phone, send = sendText) {
  if (!phone) return { skipped: 'no number' };
  const { rows } = await query(
    "SELECT to_jsonb(tenants) ->> 'karen_phone' AS karen_phone FROM tenants WHERE id = $1::uuid", [tenant.id],
  );
  const from = rows[0]?.karen_phone;
  if (!from || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return { skipped: 'texting not connected' };
  await send({ to: `+1${phone}`, from, body: optInText(tenant) });
  return { sent: true };
}

/**
 * Save one message. Returns { saved: true } for a real one; a bot that
 * filled the hidden field, or submitted faster than a person can type, gets
 * the same answer and nothing is stored, so it learns nothing.
 */
export async function saveContactMessage(tenant, body, db = { query, transaction }) {
  if (clean(body.company, 200)) return { saved: true, ignored: 'honeypot' };
  if (Number(body.elapsed) > 0 && Number(body.elapsed) < 2500) return { saved: true, ignored: 'too fast' };

  const name = requireString(body.name, 'Name', { max: 120 });
  const email = emailFrom(body.email);
  if (!email) throw new HttpError(400, 'Please enter your email address so we can reply.');
  const rawPhone = clean(body.phone, 40);
  const phone = mobileFrom(rawPhone);
  if (rawPhone && !phone) throw new HttpError(400, 'Please enter a 10-digit US mobile number, or leave it empty.');
  const message = requireString(body.message, 'Message', { max: 2000 });
  const consent = body.smsConsent === true;
  if (consent && !phone) {
    throw new HttpError(400, 'Add your mobile number to get appointment texts, or untick the box.');
  }

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const line = `${stamp} UTC · Website contact form (synergysalon.com/sms-opt-in): ${message}`
    + `\nText messages: ${consent
      ? `agreed (ticked the optional consent box) for ${phone}`
      : 'not agreed (box left unticked)'}`;
  const canPrefs = await hasColumn('contacts', 'sms_ok');
  const canConsent = await hasColumn('contacts', 'sms_consent_at');

  return db.transaction(async (client) => {
    const { rows: found } = await client.query(
      `SELECT id FROM contacts
        WHERE tenant_id = $1 AND (lower(email) = $2 OR ($3 <> '' AND regexp_replace(phone, '\\D', '', 'g') LIKE '%' || $3))
        ORDER BY (lower(email) = $2) DESC, created_at
        LIMIT 1`,
      [tenant.id, email, phone],
    );
    let id = found[0]?.id;
    if (id) {
      // A newer line on top, the same as a note added in the console, so two
      // messages from the same person both stay.
      await client.query(
        `UPDATE contacts
            SET name = CASE WHEN coalesce(name, '') = '' THEN $2 ELSE name END,
                email = CASE WHEN coalesce(email, '') = '' THEN $3 ELSE email END,
                phone = CASE WHEN coalesce(phone, '') = '' AND $4 <> '' THEN $4 ELSE phone END,
                notes = CASE WHEN coalesce(notes, '') = '' THEN $5 ELSE $5 || E'\\n\\n' || notes END,
                updated_at = now()
          WHERE id = $1`,
        [id, name, email, phone, line],
      );
      // Only a yes changes anything: an unticked box is not a "no".
      if (consent && canPrefs) await client.query('UPDATE contacts SET sms_ok = true WHERE id = $1', [id]);
    } else {
      const { rows } = await client.query(
        `INSERT INTO contacts (tenant_id, name, email, phone, source, notes, status)
         VALUES ($1, $2, $3, $4, 'Website contact form', $5, 'new')
         RETURNING id`,
        [tenant.id, name, email, phone, line],
      );
      id = rows[0].id;
      // A new client is texted only if they said so here.
      if (canPrefs) await client.query('UPDATE contacts SET sms_ok = $2::boolean WHERE id = $1', [id, consent]);
    }
    // The consent appointment texts are sent on (sms-notify.js): when, how,
    // and the number agreed for. Only a yes writes it.
    if (consent && canConsent) {
      await client.query(
        `UPDATE contacts SET sms_consent_at = now(), sms_consent_source = 'Website opt-in form',
                             sms_consent_phone = $2::text
          WHERE id = $1::uuid`,
        [id, phone],
      );
    }
    return { saved: true, contactId: id, name, email, phone, message, consent };
  });
}
