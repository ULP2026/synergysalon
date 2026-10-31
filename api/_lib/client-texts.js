/**
 * Every text with a client, either way, kept so their Activity shows the
 * conversation (2026-10-31, migration 039): what the team sends from the
 * profile (client-message.js), the appointment texts (sms-notify.js) and
 * their conversation with Karen (karen-sms.js). A file of its own, with
 * nothing but the database, so all three can use it without importing one
 * another.
 */
import { query } from './db.js';

/** Keep one text with a client. Never throws: the text has already gone (or failed). */
export async function logClientText(db, { tenantId, contactId, direction, kind, phone, body, sentBy = null, status = 'sent', error = null }) {
  if (!tenantId || !contactId || !body) return;
  const q = db?.query ? db.query.bind(db) : query;
  try {
    await q(
      `INSERT INTO client_texts (tenant_id, contact_id, direction, kind, phone, body, sent_by, status, error)
       VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7::uuid, $8::text, $9::text)`,
      [tenantId, contactId, direction, kind, phone || null, String(body).slice(0, 1600), sentBy, status,
        error ? String(error).slice(0, 500) : null],
    );
  } catch (err) {
    if (err.code !== '42P01') console.error('client text not logged', err.message);
  }
}
