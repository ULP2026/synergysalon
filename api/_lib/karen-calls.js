/**
 * Karen's Call History (asked for 2026-11-02): every call to her number, kept
 * for the owner beside the Chat History in Settings, Karen AI.
 *
 * Karen does not hold a conversation on a call: she greets the caller by name
 * and puts them through to the salon (karen-sms route). So what is kept is
 * who called, when, whether there was a salon number to put them through to,
 * and, once the salon's line has answered or not, how that went (Twilio's
 * DialCallStatus and DialCallDuration, sent to the <Dial> action).
 *
 * Like the chat log, writing never gets in the way of the call: a failure is
 * logged and ignored, and before the table exists (migration 040, also in
 * ensure-schema) nothing is kept.
 */
import { query } from './db.js';
import { clientInChairSql } from './scope.js';

const quiet = (err) => { if (err.code !== '42P01') console.error('karen-calls failed', err.message); };

/** A call has come in and been greeted. */
export async function logCallStart(tenantId, { sid, from, who, forwardedTo }, db = null) {
  const q = db ? db.query.bind(db) : query;
  try {
    await q(
      `INSERT INTO karen_calls (tenant_id, call_sid, from_phone, caller_kind, staff_id, contact_id, caller_name, forwarded_to)
       VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::uuid, $6::uuid, $7::text, $8::text)
       ON CONFLICT (call_sid) WHERE call_sid IS NOT NULL DO NOTHING`,
      [tenantId, sid || null, from || null, who?.kind || 'unknown',
        who?.kind === 'staff' ? who.id : null, who?.kind === 'client' ? who.id : null,
        who?.name || null, forwardedTo || null],
    );
  } catch (err) { quiet(err); }
}

/** The salon's line answered, or did not: Twilio's own words for it, and how long. */
export async function logCallEnd(tenantId, { sid, status, duration }, db = null) {
  if (!sid) return;
  const q = db ? db.query.bind(db) : query;
  const secs = Number(duration);
  try {
    await q(
      `UPDATE karen_calls SET dial_status = $3::text, duration_sec = $4::int, updated_at = now()
        WHERE tenant_id = $1::uuid AND call_sid = $2::text`,
      [tenantId, sid, String(status || '').slice(0, 40) || null, Number.isFinite(secs) && secs >= 0 ? Math.round(secs) : null],
    );
  } catch (err) { quiet(err); }
}

/** The latest calls, newest first, for Call History (the admin only: karen.js checks). */
export async function karenCalls(tenantId, { limit = 200, chair = null, userId = null } = {}, db = null) {
  const q = db ? db.query.bind(db) : query;
  try {
    const { rows } = await q(
      `SELECT k.id, k.from_phone, k.caller_kind, k.caller_name, k.forwarded_to, k.dial_status, k.duration_sec,
              k.created_at, k.staff_id, k.contact_id,
              u.name AS staff_name, u.avatar AS staff_avatar, u.role AS staff_role, c.name AS contact_name
         FROM karen_calls k
         LEFT JOIN staff_users u ON u.id = k.staff_id
         LEFT JOIN contacts c ON c.id = k.contact_id
        WHERE k.tenant_id = $1::uuid
          -- Anyone but the owner: their own calls and their own clients'
          -- (2026-11-04, scope.js).
          AND ($3::uuid[] IS NULL OR k.staff_id = $4::uuid
               OR (c.id IS NOT NULL AND ${clientInChairSql('c', '$3', '$4')}))
        ORDER BY k.created_at DESC, k.id DESC
        LIMIT $2::int`,
      [tenantId, Math.min(500, Math.max(1, limit)), chair ? chair.ids : null, userId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      at: r.created_at,
      phone: r.from_phone,
      kind: r.caller_kind === 'staff' || r.caller_kind === 'client' ? r.caller_kind : 'unknown',
      // The name as they are known now, else as they were when they called.
      name: r.staff_name || r.contact_name || r.caller_name || null,
      contactId: r.contact_id,
      avatar: r.staff_avatar || null,
      role: r.staff_role || null,
      forwarded: Boolean(r.forwarded_to),
      status: r.dial_status,
      durationSec: r.duration_sec,
    }));
  } catch (err) {
    if (err.code === '42P01') return [];
    throw err;
  }
}
