/**
 * The website's contact form (synergysalon.com/contact, asked for
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
  const line = `${stamp} UTC · Website contact form (synergysalon.com/contact): ${message}`
    + `\nText messages: ${consent
      ? `agreed (ticked the optional consent box) for ${phone}`
      : 'not agreed (box left unticked)'}`;
  const canPrefs = await hasColumn('contacts', 'sms_ok');

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
    return { saved: true, contactId: id, name, email, phone, message, consent };
  });
}
