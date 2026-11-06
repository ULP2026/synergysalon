/**
 * /api/staff/karen-mail: Resend's webhook for email Karen receives (asked
 * for 2026-11-06). Under /api/staff only because the project is at Vercel's
 * twelve-function limit and this router is one function; nothing here uses
 * a staff session.
 *
 * The webhook is not trusted for anything but the id of an email: the
 * email itself is fetched from Resend with the salon's own key
 * (karen-email.js `fetchReceived`), so a forged call can at most make the
 * app look at mail Resend really received for this account. Its signature
 * would need the raw body, which Vercel has usually parsed by now.
 *
 * In Resend: Webhooks, Add endpoint, this address, event email.received.
 * Answered after the work is done, so a failure is a 500 and Resend tries
 * again; a retry of one already handled is a duplicate and does nothing.
 */
import { json, readJson } from '../../_lib/http.js';
import { fetchReceived, handleEmail, normalize, tenantForEmail } from '../../_lib/karen-email.js';

export default async function karenMail(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  let event;
  try { event = await readJson(req); } catch { return json(res, 400, { error: 'Expected JSON.' }); }
  if (event?.type !== 'email.received') return json(res, 200, { ignored: true });
  const id = event.data?.email_id || event.data?.id;
  try {
    const raw = await fetchReceived(id);
    if (!raw) return json(res, 200, { ignored: true });
    const tenant = await tenantForEmail(normalize(raw));
    if (!tenant) return json(res, 200, { ignored: true, reason: 'No salon takes this address.' });
    const out = await handleEmail(raw, tenant);
    return json(res, 200, { ok: true, status: out.status || (out.duplicate ? 'duplicate' : '') });
  } catch (err) {
    console.error('karen-mail failed', id, err.message);
    return json(res, 500, { error: 'Could not handle that email yet.' });
  }
}
