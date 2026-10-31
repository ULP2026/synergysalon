/**
 * /api/staff/karen: Settings, Karen AI, Phone Number Settings.
 *
 *   GET    the number clients call or text to reach Karen, and whether
 *          texts can be answered yet (everyone on the team can read it)
 *   PATCH  {phone}  set or clear it (the admin)
 *   POST   {question, history}  Karen in the app answers, from the app
 *          guide and the salon's records, and may get an action ready
 *          (karen-desk.js; anyone on the team, who can already see all of it
 *          in the app). Replies {say, proposal, handoff}. 503 NO_AI without
 *          a key, and the console falls back to its rules.
 *   POST   {confirm: id} / {decline: id}  carry out, or drop, the action
 *          she got ready (karen-actions.js); only the person it was got
 *          ready for, within fifteen minutes, and only the latest one.
 *   POST   {log: [{role, text, at}]}  keep what was said in the app's chat,
 *          as the person signed in (karen-log.js), for Message History.
 *   GET    ?history=people  everyone who has talked to Karen; ?history=<id>
 *          one person's whole history (the admin only: Settings, Karen
 *          AI, Message History, asked for 2026-10-31).
 *
 * The number is bought from the phone provider and pointed at the webhooks
 * listed here; this records which number it is, so the team can see it and
 * so an incoming text finds its salon.
 */
import { assertSameOrigin, requireStaff, requireTeamAdmin } from '../../_lib/auth.js';
import { hasColumn, query } from '../../_lib/db.js';
import { HttpError, handler, json, readJson } from '../../_lib/http.js';
import { karenAi } from '../../_lib/karen-ai.js';
import { confirm, dropProposal, propose } from '../../_lib/karen-actions.js';
import { deskReply } from '../../_lib/karen-desk.js';
import { karenPeople, karenThread, logKaren } from '../../_lib/karen-log.js';
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
    const url = new URL(req.url, 'http://x');
    const who = url.searchParams.get('history');
    if (who) {
      // Message History is the owner's: the admin, the app's one rule
      // (canManageTeam). A stylist cannot read a colleague's chats, or the
      // list of who has been talking to her.
      const admin = await requireTeamAdmin(req);
      return json(res, 200, who === 'people'
        ? { people: await karenPeople(admin.tenant_id) }
        : { messages: await karenThread(admin.tenant_id, who) });
    }
    const user = await requireStaff(req);
    return json(res, 200, await settings(req, user.tenant_id));
  },

  async POST(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req);
    const body = await readJson(req);
    // What was said in the app's chat, kept for Message History. Always as
    // the person signed in, so nobody can write into somebody else's.
    if (Array.isArray(body.log)) {
      return json(res, 200, { kept: await logKaren(user.tenant_id, user, 'app', body.log) });
    }
    // Confirm or Cancel on the card she showed.
    if (typeof body.confirm === 'string' || typeof body.decline === 'string') {
      const tenant = await tenantForUser(user);
      if (typeof body.decline === 'string') {
        await dropProposal({ tenant, user });
        return json(res, 200, { say: 'No problem, I left it.', done: false });
      }
      return json(res, 200, await confirm({ tenant, user }, body.confirm.slice(0, 64)));
    }
    const question = typeof body.question === 'string' ? body.question.trim().slice(0, 1000) : '';
    if (!question) throw new HttpError(400, 'Ask Karen a question.');
    const ai = karenAi();
    if (!ai) throw new HttpError(503, "Karen's AI is not connected.", 'NO_AI');
    const history = (Array.isArray(body.history) ? body.history : [])
      .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string' && h.text.trim())
      .slice(-12)
      .map((h) => ({ role: h.role, text: h.text.slice(0, 2000) }));
    const tenant = await tenantForUser(user);
    // Anything said drops what was waiting: a proposal lives for one reply,
    // so "no, wait" followed later by Confirm on an old card does nothing.
    await dropProposal({ tenant, user });
    try {
      const out = await deskReply({
        tenant, user, question, history, propose: (input) => propose({ tenant, user }, input),
        // The language they chose in My Settings (2026-10-31).
        lang: body.lang === 'es' ? 'es' : 'en',
      }, ai);
      return json(res, 200, out);
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
