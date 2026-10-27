/**
 * Karen on Claude: the model proposes, the client's yes carries it out
 * through the rules' own functions, and nothing the model says can change
 * the book on its own.
 *
 * Claude is a scripted stand-in here (no key, no cost): what is tested is
 * everything around the model, which is where the guarantees live. Runs in
 * a transaction that is rolled back; test people are named ZZ.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';
import pg from 'pg';

import { DEFAULT_TZ } from '../api/_lib/config.js';
import { karenReply } from '../api/_lib/karen-sms.js';
import { tenantForUser } from '../api/_lib/tenant.js';
import { makeBookable } from './bookable.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const isLocal = url?.includes('localhost') || url?.includes('127.0.0.1');

const CLIENT_PHONE = '813.555.0166';
const STYLIST_PHONE = '+1 (813) 555-0155';

/** A stand-in for the Anthropic client: each call is answered by `script`. */
function fakeClaude(script) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(JSON.parse(JSON.stringify(params)));
        return script(params, calls.length);
      },
    },
  };
}
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const use = (name, input, id = `tu_${name}`) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });
/** What the last tool answered, as the model would read it. */
const lastResult = (params) => {
  const last = params.messages[params.messages.length - 1];
  const block = Array.isArray(last.content) ? last.content.find((b) => b.type === 'tool_result') : null;
  return block ? { ...JSON.parse(block.content), is_error: Boolean(block.is_error) } : null;
};

test('Karen on Claude proposes, and only a yes changes the book', { skip }, async () => {
  const client = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await client.connect();
  client.inTransaction = true;
  try {
    await client.query('BEGIN');
    const { rows: [t] } = await client.query("SELECT id FROM tenants WHERE slug = 'synergy'");
    const tenant = await tenantForUser({ tenant_id: t.id });
    const stylistId = await makeBookable(client, tenant.id, 'dina');
    const { rows: [svc] } = await client.query(
      "SELECT id, duration_min FROM services WHERE tenant_id = $1 AND slug = 'haircuts'", [tenant.id],
    );
    const { rows: [c] } = await client.query(
      `INSERT INTO contacts (tenant_id, name, email, phone, status)
       VALUES ($1, 'ZZ Smart Client', 'zz-karen-ai@example.com', $2, 'booked') RETURNING id`,
      [tenant.id, CLIENT_PHONE],
    );
    const start = DateTime.now().setZone(DEFAULT_TZ).plus({ days: 4 }).startOf('day').set({ hour: 15 });
    await client.query(
      `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, contact_id, starts_at, duration_min,
                                 buffer_min, during, guest_name, guest_email, manage_token)
       VALUES ($1, 'ZZKAI1', $2, $3, $4, $5::timestamptz, $6, 0,
               tstzrange($5::timestamptz, $5::timestamptz + make_interval(mins => $6::int), '[)'),
               'ZZ Smart Client', 'zz-karen-ai@example.com', 'tok-ZZKAI1')`,
      [tenant.id, stylistId, svc.id, c.id, start.toISO(), svc.duration_min],
    );
    const status = async () => (await client.query("SELECT starts_at, status FROM appointments WHERE ref = 'ZZKAI1'")).rows[0];

    // 1. "Can I move it?": the model looks, proposes a time it was given, and asks.
    let offered = null;
    const mover = fakeClaude((params, n) => {
      if (n === 1) return use('find_times', { appointment: 1 });
      if (n === 2) {
        const r = lastResult(params);
        assert.ok(r.times.length, 'free times came back for the appointment');
        offered = r.times[0].start;
        return use('propose_move', { appointment: 1, start: offered });
      }
      assert.equal(lastResult(params).is_error, false);
      return say('Hi ZZ! I can move your haircut with Dina. Shall I? Reply YES to confirm or NO.');
    });
    const ask = await karenReply(tenant, CLIENT_PHONE, 'hey can i move my haircut to another day?', client, { ai: mover });
    assert.match(ask, /^Hi ZZ! I can move your haircut/, 'the model greets; the rules\' "Hi" is not added on top');
    assert.match(ask, /Reply STOP to opt out, HELP for help\.$/, 'the opt-out line is added by code on the first reply');
    assert.equal(mover.calls[0].model, 'claude-opus-5-5');
    // The day's facts, apart from the fixed rules (which name the $40 scalp analysis).
    const shown = mover.calls[0].system[1].text;
    assert.match(shown, /Texting: ZZ Smart Client, a client/);
    assert.match(shown, /1\. Haircuts? with Dina on /, 'their own appointment, numbered');
    assert.doesNotMatch(shown, /\$\d/, 'no prices reach the model');
    assert.match(shown, /Booking new appointments by text: NOT open yet/);
    assert.equal((await status()).status, 'booked');
    assert.equal(new Date((await status()).starts_at).getTime(), start.toMillis(), 'proposing changes nothing');

    // 2. A plain yes is carried out here, without asking the model.
    const never = fakeClaude(() => { throw new Error('a plain yes must not reach the model'); });
    const done = await karenReply(tenant, CLIENT_PHONE, 'Yes please!', client, { ai: never });
    assert.match(done, /^All set! Your Haircuts? with Dina is now /);
    assert.doesNotMatch(done, /Reply STOP/, 'once a conversation');
    assert.equal(new Date((await status()).starts_at).getTime(), new Date(offered).getTime());
    const { rows: [note] } = await client.query('SELECT notes FROM contacts WHERE id = $1', [c.id]);
    assert.match(note.notes, /Moved by text with Karen: /);

    // 3. A time the model made up is refused, and a number not in the list reaches nothing.
    const liar = fakeClaude((params, n) => {
      if (n === 1) return use('propose_move', { appointment: 1, start: start.set({ hour: 3 }).toISO() });
      if (n === 2) {
        assert.match(lastResult(params).error, /not open/);
        return use('propose_cancel', { appointment: 7 });
      }
      assert.match(lastResult(params).error, /no appointment with that number/);
      return say('Let me check what is free.');
    });
    await karenReply(tenant, CLIENT_PHONE, 'move it to 3am', client, { ai: liar });
    const after = await client.query("SELECT state FROM karen_threads WHERE phone = '8135550166'");
    assert.equal(after.rows[0].state.pending, null, 'nothing is waiting for a yes');

    // 4. Cancelling: proposed, then a plain no keeps it.
    const canceller = fakeClaude((params) => (lastResult(params) ? say('Cancel your haircut with Dina? Reply YES to cancel, or NO to keep it.')
      : use('propose_cancel', { appointment: 1 })));
    await karenReply(tenant, CLIENT_PHONE, 'actually i need to cancel my appointment', client, { ai: canceller });
    assert.ok(canceller.calls[0].messages.length > 1, 'the conversation so far goes with each text');
    const kept = await karenReply(tenant, CLIENT_PHONE, 'no', client, { ai: never });
    assert.match(kept, /nothing has changed/);
    assert.equal((await status()).status, 'booked');

    // A proposal lasts one reply: "hmm, wait" drops it, and a later yes reaches nothing.
    await karenReply(tenant, CLIENT_PHONE, 'cancel my appointment please', client, { ai: canceller });
    const ponder = fakeClaude(() => say('Take your time! Your haircut is still booked.'));
    await karenReply(tenant, CLIENT_PHONE, 'hmm wait let me check my calendar', client, { ai: ponder });
    assert.match(ponder.calls[0].system[1].text, /proposal is now dropped/);
    await karenReply(tenant, CLIENT_PHONE, 'yes', client, { ai: ponder });
    assert.equal((await status()).status, 'booked', 'a yes after the proposal lapsed cancels nothing');

    // ...and then yes, through a fresh proposal.
    await karenReply(tenant, CLIENT_PHONE, 'ok cancel my appointment', client, { ai: canceller });
    const cancelled = await karenReply(tenant, CLIENT_PHONE, 'yes', client, { ai: never });
    assert.match(cancelled, /is cancelled/);
    assert.equal((await status()).status, 'cancelled');

    // 5. If the model fails, the rules answer that text.
    const broken = fakeClaude(() => { throw new Error('API down'); });
    const fallback = await karenReply(tenant, CLIENT_PHONE, 'what are my appointments', client, { ai: broken });
    assert.match(fallback, /no upcoming appointments/);

    // 6. A stranger asking for a person: the salon is alerted once.
    let alerts = 0;
    const handover = fakeClaude((params, n) => {
      if (n === 1 || n === 3) return use('alert_salon', { reason: 'wants a person', summary: 'ZZ wants to talk about a color.' }, `tu_${n}`);
      if (n === 2) { alerts += 1; assert.match(lastResult(params).done, /emailed/); }
      if (n === 4) assert.match(lastResult(params).done, /already has/);
      return say('The salon will get back to you soon.');
    });
    await karenReply(tenant, '+18135550144', 'can i talk to someone about my color', client, { ai: handover });
    await karenReply(tenant, '+18135550144', 'please call me', client, { ai: handover });
    assert.equal(alerts, 1);

    // 7. The team still gets the rules: the model is not asked.
    await client.query(
      `INSERT INTO staff_users (tenant_id, name, email, role, phone, password_hash)
       VALUES ($1, 'ZZ Smart Stylist', 'zz-karen-ai-stylist@example.com', 'stylist', $2, 'x')`,
      [tenant.id, STYLIST_PHONE],
    );
    const staff = await karenReply(tenant, STYLIST_PHONE, "what's on today?", client, { ai: never });
    assert.match(staff, /^Hi ZZ!/);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});

test('a reply after the webhook goes out through the provider\'s API, from Karen\'s number', async () => {
  const saved = { sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN };
  process.env.TWILIO_ACCOUNT_SID = 'ACzz';
  process.env.TWILIO_AUTH_TOKEN = 'zz-token';
  try {
    const { sendText } = await import('../api/_lib/karen-sms.js');
    let seen;
    const ok = async (u, init) => { seen = { u, init }; return { ok: true, json: async () => ({ sid: 'SMzz' }) }; };
    await sendText({ to: '+18135550166', from: '+18138514556', body: 'Hi!' }, ok);
    assert.equal(seen.u, 'https://api.twilio.com/2010-04-01/Accounts/ACzz/Messages.json');
    assert.equal(seen.init.headers.Authorization, `Basic ${Buffer.from('ACzz:zz-token').toString('base64')}`);
    assert.equal(String(seen.init.body), 'To=%2B18135550166&From=%2B18138514556&Body=Hi%21');
    const refused = async () => ({ ok: false, status: 400, text: async () => 'not registered' });
    await assert.rejects(sendText({ to: '+1', from: '+1', body: 'x' }, refused), /Twilio refused the text \(400\): not registered/);
  } finally {
    for (const [k, v] of [['TWILIO_ACCOUNT_SID', saved.sid], ['TWILIO_AUTH_TOKEN', saved.token]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
