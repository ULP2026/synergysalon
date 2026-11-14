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
 *   POST   {interpret: {question, options, text}}  which choice a typed reply means
 *          she got ready (karen-actions.js); only the person it was got
 *          ready for, within fifteen minutes, and only the latest one.
 *   POST   {log: [{role, text, at}]}  keep what was said in the app's chat,
 *          as the person signed in (karen-log.js), for Message History.
 *   GET    ?calls=1  Call History: every call to Karen's number, newest
 *          first (the admin only, 2026-11-02; karen-calls.js).
 *   GET    ?history=people  everyone who has talked to Karen; ?history=<id>
 *          one person's whole history (the admin only: Settings, Karen
 *          AI, Message History, asked for 2026-10-31).
 *   DELETE {kind: 'chat'|'calls'|'emails', ids, confirm: true}  remove
 *          records from Chat, Call or Email History (Select, asked for
 *          2026-11-09; the owner and admins only, deleteHistory).
 *
 * The number is bought from the phone provider and pointed at the webhooks
 * listed here; this records which number it is, so the team can see it and
 * so an incoming text finds its salon.
 */
import { assertSameOrigin, canManageTeam, requireStaff, requireTeamAdmin } from '../../_lib/auth.js';
import { chairOf } from '../../_lib/scope.js';
import { hasColumn, query } from '../../_lib/db.js';
import { HttpError, handler, json, readJson } from '../../_lib/http.js';
import { karenAi } from '../../_lib/karen-ai.js';
import { confirm, dropProposal, propose } from '../../_lib/karen-actions.js';
import { karenCalls } from '../../_lib/karen-calls.js';
import { KAREN_INSTRUCTIONS_MAX, cleanInstructions } from '../../_lib/karen-instructions.js';
import { emailLastReceived, emailThread, emailThreads } from '../../_lib/karen-email.js';
import { deskReply, interpretReply } from '../../_lib/karen-desk.js';
import { karenPeople, karenThread, logKaren } from '../../_lib/karen-log.js';
import { phoneKey, prettyPhone } from '../../_lib/karen-sms.js';
import { tenantForUser } from '../../_lib/tenant.js';

async function settings(req, tenantId) {
  const { rows } = await query(
    `SELECT to_jsonb(tenants) ->> 'karen_phone' AS karen_phone, phone,
            to_jsonb(tenants) ->> 'karen_instructions' AS karen_instructions
       FROM tenants WHERE id = $1::uuid`,
    [tenantId],
  );
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  const base = `https://${host}/api/staff`;
  return {
    phone: rows[0]?.karen_phone || '',
    pretty: prettyPhone(rows[0]?.karen_phone),
    salonPhone: rows[0]?.phone || '',
    // Karen's special instructions (Rec 2e): the owner's notes she reads.
    instructions: cleanInstructions(rows[0]?.karen_instructions),
    instructionsMax: KAREN_INSTRUCTIONS_MAX,
    // Texts are answered only once the provider's token is in Vercel, which
    // is what proves a text really came from that number.
    texting: Boolean(process.env.TWILIO_AUTH_TOKEN),
    webhooks: { sms: `${base}/karen-sms`, voice: `${base}/karen-voice` },
  };
}

/** Most records one delete removes: a screenful or two, not the whole log. */
export const HISTORY_DELETE_MAX = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Records taken out of Karen AI's histories (asked for 2026-11-09), by the
 * owner or an admin, chosen with Select in each card:
 *   chat    a person's whole conversation with Karen (karen_messages), by
 *           their login's id, or 'removed' for those whose login is gone;
 *   calls   rows of Call History (karen_calls);
 *   emails  rows of Email History (message_sends). The log is all it is:
 *           nothing reads it to decide whether to send (a reminder is
 *           marked on its appointment), so deleting one never sends again.
 *           It also leaves the client's Activity, which reads the same log.
 * Only this salon's rows, whatever ids are sent. Returns how many went.
 */
export async function deleteHistory(tenantId, kind, rawIds, db = null) {
  const q = db ? db.query.bind(db) : query;
  if (!Array.isArray(rawIds)) throw new HttpError(400, 'Choose what to delete first.');
  const ids = [...new Set(rawIds.filter((x) => typeof x === 'string' || typeof x === 'number').map(String))];
  if (!ids.length) throw new HttpError(400, 'Choose what to delete first.');
  if (ids.length > HISTORY_DELETE_MAX) throw new HttpError(400, `Delete up to ${HISTORY_DELETE_MAX} at a time.`);
  if (kind === 'chat') {
    const users = ids.filter((x) => UUID.test(x));
    const removed = ids.includes('removed');
    const { rowCount } = await q(
      `DELETE FROM karen_messages WHERE tenant_id = $1::uuid
          AND (user_id = ANY($2::uuid[]) OR ($3::boolean AND user_id IS NULL))`,
      [tenantId, users, removed],
    );
    return { deleted: users.length + (removed ? 1 : 0), rows: rowCount };
  }
  if (kind === 'calls' || kind === 'emails') {
    const ok = kind === 'calls' ? ids.filter((x) => /^\d{1,18}$/.test(x)) : ids.filter((x) => UUID.test(x));
    const { rowCount } = await q(
      `DELETE FROM ${kind === 'calls' ? 'karen_calls' : 'message_sends'}
        WHERE tenant_id = $1::uuid AND id::text = ANY($2::text[])`,
      [tenantId, ok],
    );
    return { deleted: rowCount, rows: rowCount };
  }
  throw new HttpError(400, 'Say which history to delete from.');
}

export default handler({
  async GET(req, res) {
    const url = new URL(req.url, 'http://x');
    // Settings, Karen AI for everybody (2026-11-04), read-only for anyone
    // but the owner: her number and picture; Chat History of their own
    // chats with her; Call History of calls from their own clients (scope.js).
    const user = await requireStaff(req);
    const owner = canManageTeam(user);
    if (url.searchParams.has('calls')) {
      return json(res, 200, {
        calls: await karenCalls(user.tenant_id, { chair: await chairOf(user), userId: user.id }),
      });
    }
    // Email Inbox (2026-11-06, karen-email.js): the admin only, like the
    // other histories; ?mail=threads the conversations, ?mail=<id> one.
    const mail = url.searchParams.get('mail');
    if (mail) {
      if (!owner) throw new HttpError(403, 'Only the admin reads the salon\'s email.');
      if (mail === 'threads') {
        const { rows: [t] } = await query(
          "SELECT COALESCE((to_jsonb(tenants) ->> 'karen_email_on')::boolean, true) AS on, to_jsonb(tenants) ->> 'reply_to' AS reply_to FROM tenants WHERE id = $1::uuid",
          [user.tenant_id],
        );
        return json(res, 200, {
          threads: await emailThreads(user.tenant_id),
          on: t?.on !== false,
          inbox: t?.reply_to || '',
          last: await emailLastReceived(user.tenant_id),
          // Karen reads mail only once Resend can be asked for it.
          ready: Boolean(process.env.RESEND_API_KEY),
          webhook: `https://${String(req.headers['x-forwarded-host'] || req.headers.host || '')}/api/staff/karen-mail`,
        });
      }
      const thread = await emailThread(user.tenant_id, mail);
      if (!thread) throw new HttpError(404, 'No such conversation.');
      return json(res, 200, thread);
    }
    const who = url.searchParams.get('history');
    if (who) {
      // A stylist reads only their own conversation, never a colleague's,
      // nor the list of who else has been talking to her.
      if (who === 'people') {
        const people = await karenPeople(user.tenant_id);
        return json(res, 200, { people: owner ? people : people.filter((p) => String(p.id) === String(user.id)) });
      }
      if (!owner && String(who) !== String(user.id)) throw new HttpError(404, 'No such conversation.');
      return json(res, 200, { messages: await karenThread(user.tenant_id, who) });
    }
    return json(res, 200, { ...(await settings(req, user.tenant_id)), readOnly: !owner, ...(owner ? {} : { webhooks: null }) });
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
    // Which choice of a booking step a typed reply means (karen-desk.js).
    if (body.interpret && typeof body.interpret === 'object') {
      const ai = karenAi();
      if (!ai) throw new HttpError(503, "Karen's AI is not connected.", 'NO_AI');
      const { question: asked, options, text } = body.interpret;
      if (!Array.isArray(options) || !options.length || typeof text !== 'string' || !text.trim()) {
        throw new HttpError(400, 'Nothing to read.');
      }
      try {
        return json(res, 200, await interpretReply(ai, { question: String(asked || ''), options: options.map(String), text }));
      } catch (err) {
        console.error('karen interpret failed', err);
        throw new HttpError(502, "Karen couldn't read that just now.", 'AI_FAILED');
      }
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

  async DELETE(req, res) {
    assertSameOrigin(req);
    // The owner and admins only (canManageTeam), as the histories are theirs to read.
    const user = await requireTeamAdmin(req);
    const body = await readJson(req);
    if (body.confirm !== true) throw new HttpError(400, 'Confirm the delete first.');
    return json(res, 200, await deleteHistory(user.tenant_id, body.kind, body.ids));
  },

  async PATCH(req, res) {
    assertSameOrigin(req);
    const user = await requireTeamAdmin(req);
    const tenant = await tenantForUser(user);
    const body = await readJson(req);
    // Karen answers email on her own, or only files it for a person.
    if (typeof body.emailOn === 'boolean') {
      if (!await hasColumn('tenants', 'karen_email_on')) {
        throw new HttpError(409, 'Karen\'s email is not switched on for this salon yet.', 'NOT_MIGRATED');
      }
      await query('UPDATE tenants SET karen_email_on = $2 WHERE id = $1::uuid', [tenant.id, body.emailOn]);
      return json(res, 200, { on: body.emailOn });
    }
    // Karen's special instructions (Rec 2e, 2026-11-12). Owner and admins
    // only, like the rest of this PATCH; empty clears them.
    if (typeof body.instructions === 'string') {
      if (body.instructions.trim().length > KAREN_INSTRUCTIONS_MAX) {
        throw new HttpError(400, `Keep Karen's instructions under ${KAREN_INSTRUCTIONS_MAX} characters.`);
      }
      if (!await hasColumn('tenants', 'karen_instructions')) {
        throw new HttpError(409, "Karen's instructions are not switched on for this salon yet.", 'NOT_MIGRATED');
      }
      await query('UPDATE tenants SET karen_instructions = $2 WHERE id = $1::uuid',
        [tenant.id, cleanInstructions(body.instructions) || null]);
      return json(res, 200, await settings(req, tenant.id));
    }
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
