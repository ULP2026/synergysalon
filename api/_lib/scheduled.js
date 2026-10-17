/**
 * The queue behind M4 to M11: messages that go out later, not now.
 *
 * The first four guest messages (confirmation, reschedule, cancellation,
 * reminder) fire at the moment something happens and send inline. Everything
 * in the automation catalog from M4 down is "send this in three hours" or
 * "in ten days", which the app had no way to express.
 *
 * So a trigger calls enqueue() and returns; a daily cron calls drain() and
 * sends whatever is due; and anything that makes a queued message pointless
 * calls cancelFor() rather than deleting the row, so the reason survives.
 *
 * ONE HONEST LIMIT. Vercel's Hobby plan runs a cron once a day, so a message
 * due at "+3 hours" goes out on the next pass and can be up to a day late.
 * The real intent is still written to send_after rather than rounded to the
 * next run: the timings become accurate the moment the plan allows an hourly
 * cron, and nobody has to find and change seventeen call sites to get there.
 */
import { query } from './db.js';
import { MESSAGE_KINDS } from './email.js';

/** Turn a human delay into the timestamp the drain compares against. */
export function at({ hours = 0, days = 0 } = {}, from = new Date()) {
  return new Date(from.getTime() + (hours * 3600 + days * 86400) * 1000);
}

/**
 * Put one message in the queue.
 *
 * Silent about duplicates: the unique index means a trigger that runs twice
 * (a double click, a retried webhook) queues one message, not two, and the
 * second attempt is a no-op rather than an error the caller has to handle.
 * Best-effort for the same reason the send log is -- a booking must not fail
 * because a follow-up could not be queued.
 */
export async function enqueue(kind, {
  tenantId, appointmentId = null, contactId = null, toName = null, toEmail, sendAfter,
}) {
  if (!tenantId || !toEmail || !MESSAGE_KINDS.includes(kind)) return false;
  try {
    const { rowCount } = await query(
      `INSERT INTO scheduled_messages
         (tenant_id, kind, appointment_id, contact_id, to_name, to_email, send_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [tenantId, kind, appointmentId, contactId, toName, toEmail, sendAfter],
    );
    return rowCount > 0;
  } catch (err) {
    console.warn('enqueue failed', kind, err.message);
    return false;
  }
}

/**
 * Stop messages that no longer make sense.
 *
 * This is how the catalog's "stops when" column is implemented: a guest who
 * rebooks should not then receive three win-backs. Only unsent, uncancelled
 * rows are touched, so a message already delivered is never rewritten.
 *
 * Pass kinds to narrow it; omit them to clear everything pending for that
 * appointment or contact.
 */
export async function cancelFor({ appointmentId = null, contactId = null }, reason, kinds = null) {
  if (!appointmentId && !contactId) return 0;
  try {
    const { rowCount } = await query(
      `UPDATE scheduled_messages
          SET cancelled_at = now(), cancel_reason = $3
        WHERE sent_at IS NULL AND cancelled_at IS NULL
          AND ($1::uuid IS NULL OR appointment_id = $1)
          AND ($2::uuid IS NULL OR contact_id = $2)
          AND ($4::text[] IS NULL OR kind = ANY($4))`,
      [appointmentId, contactId, String(reason || '').slice(0, 200), kinds],
    );
    return rowCount;
  } catch (err) {
    console.warn('cancelFor failed', err.message);
    return 0;
  }
}
