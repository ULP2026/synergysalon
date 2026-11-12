/**
 * An email that bounces is Failed in Sent History, Email History and the
 * client's Activity (asked for 2026-11-02, built 2026-11-12). Until now a
 * row said Sent the moment Resend accepted it, so the Nov 2 test to
 * "...@gmail.conm" read Sent although it never arrived.
 *
 * Resend calls /api/staff/karen-mail with email.bounced (and email.failed or
 * email.suppressed, where the account sends them). As with received mail,
 * the webhook is trusted for the email's id only: the email is fetched from
 * Resend with the salon's own key and marked only if Resend itself says it
 * bounced, so a forged call cannot fail a delivered email. The id is the one
 * `send` in email.js got back and kept on the row (message_sends.provider_id,
 * 060); emails sent before that have none and are left alone.
 *
 * In Resend: Webhooks, the endpoint already there for email.received, tick
 * email.bounced too.
 */
import { query } from './db.js';

export const BOUNCE_EVENTS = new Set(['email.bounced', 'email.failed', 'email.suppressed']);
/** What Resend's own record must say for the row to be marked. */
const BAD_LAST = new Set(['bounced', 'failed', 'suppressed']);
const EMAIL_URL = 'https://api.resend.com/emails/';

/** The email as Resend has it, or null without a key or a sane id. */
export async function fetchSent(id, { fetchFn = fetch } = {}) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !/^[A-Za-z0-9-]{8,80}$/.test(String(id || ''))) return null;
  const res = await fetchFn(`${EMAIL_URL}${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Resend would not give the sent email ${id}: ${res.status}`);
  return res.json();
}

/** The reason shown on hover, from the webhook's bounce details if any. */
export function bounceReason(event, last) {
  const b = event?.data?.bounce || {};
  const why = String(b.message || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (last === 'suppressed') return 'Not sent: this address bounced or complained before, so Resend held it back.';
  if (why) return `Bounced${b.type ? ` (${String(b.type).slice(0, 40)})` : ''}: ${why}`;
  return last === 'failed' ? 'Failed: Resend could not deliver it.' : 'Bounced: the receiving server did not accept it.';
}

/**
 * Handle one webhook. Returns { marked } with how many rows turned Failed
 * (0 for an email the app did not log, or one already marked), or
 * { ignored } with why. Throws if Resend could not be asked, so the webhook
 * answers 500 and Resend tries again.
 */
export async function handleBounce(event, { db = { query }, fetchFn = fetch } = {}) {
  if (!BOUNCE_EVENTS.has(event?.type)) return { ignored: 'not a bounce' };
  const id = event.data?.email_id || event.data?.id;
  const email = await fetchSent(id, { fetchFn });
  if (!email) return { ignored: 'no key or no id' };
  const last = String(email.last_event || '').toLowerCase();
  if (!BAD_LAST.has(last)) return { ignored: `Resend says ${last || 'nothing'} for it` };
  const { rowCount } = await db.query(
    `UPDATE message_sends SET status = 'failed', error = $2::text
      WHERE provider_id = $1::text AND status IS DISTINCT FROM 'failed'`,
    [id, bounceReason(event, last)],
  );
  return { marked: rowCount };
}
