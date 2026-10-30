/**
 * /api/staff/karen: Settings, Karen AI, Phone Number Settings.
 *
 *   GET    the number clients call or text to reach Karen, and whether
 *          texts can be answered yet (everyone on the team can read it)
 *   PATCH  {phone}  set or clear it (the admin)
 *   POST   {question, history}  Karen in the app answers a question from
 *          the salon's records (karen-desk.js; anyone on the team, who can
 *          already see all of it in the app). 503 NO_AI without a key, and
 *          the console falls back to its rules.
 *
 * The number is bought from the phone provider and pointed at the webhooks
 * listed here; this records which number it is, so the team can see it and
 * so an incoming text finds its salon.
 */
import { assertSameOrigin, requireStaff, requireTeamAdmin } from '../../_lib/auth.js';
import { hasColumn, query } from '../../_lib/db.js';
import { HttpError, handler, json, readJson } from '../../_lib/http.js';
import { karenAi } from '../../_lib/karen-ai.js';
import { deskReply } from '../../_lib/karen-desk.js';
import { phoneKey, prettyPhone } from '../../_lib/karen-sms.js';
import { tenantForUser } from '../../_lib/tenant.js';

async function settings(req, tenantId) {
  const { rows } = await query(
    "SELECT to_jsonb(tenants) ->> 'karen_phone' AS karen_phone, phone FROM tenants WHERE id = $1::uuid",
    [tenantId],
  );
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  const base = `https://${host}/api/staff`;
  return {
    phone: rows[0]?.karen_phone || '',
    pretty: prettyPhone(rows[0]?.karen_phone),
    salonPhone: rows[0]?.phone || '',
    // Texts are answered only once the provider's token is in Vercel, which
    // is what proves a text really came from that number.
    texting: Boolean(process.env.TWILIO_AUTH_TOKEN),
    webhooks: { sms: `${base}/karen-sms`, voice: `${base}/karen-voice` },
  };
}

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req);
    return json(res, 200, await settings(req, user.tenant_id));
  },

  async POST(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req);
    const body = await readJson(req);
    const question = typeof body.question === 'string' ? body.question.trim().slice(0, 1000) : '';
    if (!question) throw new HttpError(400, 'Ask Karen a question.');
    const ai = karenAi();
    if (!ai) throw new HttpError(503, "Karen's AI is not connected.", 'NO_AI');
    const history = (Array.isArray(body.history) ? body.history : [])
      .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string' && h.text.trim())
      .slice(-12)
      .map((h) => ({ role: h.role, text: h.text.slice(0, 2000) }));
    const tenant = await tenantForUser(user);
    try {
      return json(res, 200, { say: await deskReply({ tenant, user, question, history }, ai) });
    } catch (err) {
      console.error('karen-desk failed', err);
      throw new HttpError(502, "Karen couldn't look that up just now.", 'AI_FAILED');
    }
  },

  async PATCH(req, res) {
    assertSameOrigin(req);
    const user = await requireTeamAdmin(req);
    const tenant = await tenantForUser(user);
    const body = await readJson(req);
    const raw = typeof body.phone === 'string' ? body.phone.trim() : '';
    const key = phoneKey(raw);
    if (raw && !key) throw new HttpError(400, 'That phone number looks too short: include the area code.');
    if (!await hasColumn('tenants', 'karen_phone')) {
      throw new HttpError(409, 'Karen\'s number is not switched on for this salon yet.', 'NOT_MIGRATED');
    }
    await query('UPDATE tenants SET karen_phone = $2 WHERE id = $1::uuid', [tenant.id, key ? `+1${key}` : null]);
    return json(res, 200, await settings(req, tenant.id));
  },
});
