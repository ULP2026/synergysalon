/**
 * Karen answers the salon's email (2026-11-06, karen-email.js): each email
 * stored once and in its conversation, answered at most once, never when
 * it is automatic, sensitive, not the salon's business, from the team or
 * from a sender nobody vouched for, and a YES by email carries out what she
 * proposed, as by text.
 *
 * Claude and the email provider are stand-ins (no key, no cost, nothing
 * sent). Runs in a transaction that is rolled back; test people are ZZ.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';
import pg from 'pg';

import { DEFAULT_TZ } from '../api/_lib/config.js';
import { answerOf, handleEmail, newPart, normalize, notForKaren } from '../api/_lib/karen-email.js';
import { tenantForUser } from '../api/_lib/tenant.js';
import { makeBookable } from './bookable.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const isLocal = url?.includes('localhost') || url?.includes('127.0.0.1');

const INBOX = 'zz-inbox@example.com';

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
const lastResult = (params) => {
  const last = params.messages[params.messages.length - 1];
  const block = Array.isArray(last.content) ? last.content.find((b) => b.type === 'tool_result') : null;
  return block ? JSON.parse(block.content) : null;
};
const never = fakeClaude(() => { throw new Error('the model must not be asked'); });
/** The sorter's one word, then `rest` for Karen herself. */
const sorted = (word, rest = () => say('Thanks!')) => fakeClaude((params, n) => (
  params.model === 'claude-haiku-5-5' ? say(word) : rest(params, n)));

let seq = 0;
function email(over = {}) {
  seq += 1;
  return {
    object: 'email',
    id: `zz-recv-${seq}-${Date.now()}`,
    from: 'ZZ Mail Client <zz-mail@example.com>',
    to: [INBOX],
    cc: [],
    subject: 'My haircut',
    text: 'Hello',
    html: null,
    headers: {},
    message_id: `<zz-${seq}-${Date.now()}@example.com>`,
    authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    ...over,
  };
}

test('what Karen reads of an email, and what is not for her', () => {
  assert.equal(newPart('Can I come at 3?\n\nThanks,\nMaria\n\nOn Mon, Nov 3, 2026 at 9:00 AM Synergy Salon <admin@synergysalon.com> wrote:\n> Hi Maria'),
    'Can I come at 3?\n\nThanks,\nMaria');
  assert.equal(newPart('Yes\n\nSent from my iPhone'), 'Yes');
  assert.equal(answerOf('Yes please!\n\nThanks,\nMaria'), 'yes please!', 'a yes on the first line is the answer');
  assert.match(answerOf('Hi Karen,\nyes but can it be later?'), /^hi karen,/, 'anything more goes to the model whole');

  const m = normalize(email({ from: 'Maria <MARIA@Example.com>', text: 'Hi' }));
  assert.equal(m.from.email, 'maria@example.com');
  assert.equal(m.from.name, 'Maria');
  assert.equal(m.verified, true);
  const spoof = normalize(email({ authentication: { dkim: 'fail', dmarc: 'fail' } }));
  assert.equal(spoof.verified, false);
  const routed = normalize(email({
    authentication: { dkim: 'fail', dmarc: 'none' },
    headers: { 'ARC-Authentication-Results': 'i=1; mx.google.com; dkim=pass header.i=@example.com; dmarc=pass' },
  }));
  assert.equal(routed.verified, true, 'Google\'s verdict from admin@ counts');

  const why = (over) => notForKaren(normalize(email(over)), { ownAddresses: [INBOX] });
  assert.equal(why({}), null);
  assert.match(why({ headers: { 'List-Unsubscribe': '<mailto:x@shop.example>' } }), /newsletter/);
  assert.match(why({ headers: { 'Auto-Submitted': 'auto-replied' } }), /automatic/);
  assert.match(why({ headers: { Precedence: 'bulk' } }), /automatic/);
  assert.match(why({ from: 'Shop <noreply@shop.example>' }), /does not take replies/);
  assert.match(why({ from: 'mailer-daemon@googlemail.com' }), /does not take replies/);
  assert.match(why({ from: `Salon <${INBOX}>` }), /salon or by Karen/);
  assert.match(why({ headers: { 'X-Synergy-Karen': '1' } }), /salon or by Karen/);
  assert.match(why({ text: '\n> only quoted\n' }), /Nothing written/);
});

test('Karen answers an email once, in its thread, and a YES by email carries it out', { skip }, async () => {
  const client = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await client.connect();
  client.inTransaction = true;
  const savedKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY; // the cancellation email the YES triggers is not sent
  try {
    await client.query('BEGIN');
    const { rows: [t] } = await client.query("SELECT id FROM tenants WHERE slug = 'synergy'");
    const tenant = { ...(await tenantForUser({ tenant_id: t.id })), reply_to: INBOX };
    const stylistId = await makeBookable(client, tenant.id, 'dina');
    const { rows: [svc] } = await client.query(
      "SELECT id, duration_min FROM services WHERE tenant_id = $1 AND slug = 'womens-cut'", [tenant.id],
    );
    const { rows: [c] } = await client.query(
      `INSERT INTO contacts (tenant_id, name, email, phone, status)
       VALUES ($1, 'ZZ Mail Client', 'zz-mail@example.com', '8135550177', 'booked') RETURNING id`,
      [tenant.id],
    );
    const start = DateTime.now().setZone(DEFAULT_TZ).plus({ days: 5 }).startOf('day').set({ hour: 14 });
    await client.query(
      `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, contact_id, starts_at, duration_min,
                                 buffer_min, during, guest_name, guest_email, manage_token)
       VALUES ($1, 'ZZKEM1', $2, $3, $4, $5::timestamptz, $6, 0,
               tstzrange($5::timestamptz, $5::timestamptz + make_interval(mins => $6::int), '[)'),
               'ZZ Mail Client', 'zz-mail@example.com', 'tok-ZZKEM1')`,
      [tenant.id, stylistId, svc.id, c.id, start.toISO(), svc.duration_min],
    );
    const sends = [];
    const send = async (msg) => { sends.push(msg); return { sent: true, id: `zz-sent-${sends.length}`, from: `Karen <${INBOX}>` }; };
    const run = (raw, ai) => handleEmail(raw, tenant, { db: client, ai, send, ownAddresses: [INBOX] });

    // 1. A client asks to cancel: sorted as the salon's, Karen proposes, one reply goes.
    const first = email({
      subject: 'My haircut',
      text: 'Hi, I need to cancel my haircut please.\n\nThanks,\nZZ\n\nOn Mon, Nov 3, 2026 Synergy <x@y.com> wrote:\n> earlier',
    });
    const karen = sorted('salon', (params) => (lastResult(params)
      ? say('Hi ZZ, I can cancel your Women\'s Cut with Dina. Reply YES to confirm, or NO to keep it.')
      : use('propose_cancel', { appointment: 1 })));
    const r1 = await run(first, karen);
    assert.equal(r1.status, 'replied', r1.note);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].to, 'zz-mail@example.com');
    assert.equal(sends[0].subject, 'Re: My haircut');
    assert.equal(sends[0].inReplyTo, first.message_id);
    assert.ok(sends[0].references.includes(first.message_id));
    assert.match(sends[0].text, /Reply YES to confirm[\s\S]*\n\nKaren\nAssistant at /, 'the signature is the app\'s');
    const system = karen.calls.find((p) => p.model !== 'claude-haiku-5-5').system;
    assert.match(system[0].text, /answering an email that somebody sent to the salon/);
    assert.match(system[1].text, /Emailing: ZZ Mail Client, a client of the salon \(this email address is on file\)/);
    const { rows: stored } = await client.query(
      'SELECT direction, status, body FROM email_messages WHERE thread_id = $1 ORDER BY created_at, direction', [r1.threadId],
    );
    assert.deepEqual(stored.map((s) => [s.direction, s.status]), [['in', 'replied'], ['out', 'sent']]);
    assert.doesNotMatch(stored[0].body, /earlier|wrote:/, 'the quoted thread is not kept as theirs');
    assert.equal((await client.query("SELECT status FROM appointments WHERE ref = 'ZZKEM1'")).rows[0].status, 'booked', 'proposing changes nothing');

    // 2. The same email again (a retried webhook, or received twice): nothing.
    assert.deepEqual(await run(first, never), { duplicate: true });
    assert.deepEqual(await run({ ...first, id: `${first.id}-again` }, never), { duplicate: true }, 'same Message-ID');
    assert.equal(sends.length, 1, 'never a second reply');

    // 3. They reply YES (with their sign-off) in the same thread: carried out, no model asked.
    const yes = email({
      subject: 'Re: My haircut',
      text: 'Yes please!\n\nZZ\n\nOn Tue Karen wrote:\n> Reply YES to confirm',
      headers: { 'In-Reply-To': '<resend-made-this@resend.dev>', References: `${first.message_id} <resend-made-this@resend.dev>` },
    });
    const r3 = await run(yes, never);
    assert.equal(r3.status, 'replied', r3.note);
    assert.equal(r3.threadId, r1.threadId, 'one conversation');
    assert.equal((await client.query("SELECT status FROM appointments WHERE ref = 'ZZKEM1'")).rows[0].status, 'cancelled');
    assert.match(sends[1].text, /^Done: your .+ is cancelled\. Reply to this email whenever/);
    assert.equal(sends[1].subject, 'Re: My haircut');

    // 4. Not for Karen: stored, not answered, the model not asked.
    const news = await run(email({ from: 'Shop News <news@shop.example>', headers: { 'List-Unsubscribe': '<mailto:u@shop.example>' } }), never);
    assert.equal(news.status, 'skipped');
    const auto = await run(email({ subject: 'Out of office', headers: { 'Auto-Submitted': 'auto-replied' } }), never);
    assert.equal(auto.status, 'skipped');
    const spoof = await run(email({ subject: 'Cancel everything', authentication: { dkim: 'fail', dmarc: 'fail' } }), never);
    assert.equal(spoof.status, 'flagged');
    assert.match(spoof.note, /could not be verified/);

    // 5. The sorter: sensitive is the team's, anything else is left.
    const hurt = await run(email({ subject: 'My scalp is burning after my color' }), sorted('sensitive'));
    assert.equal(hurt.status, 'flagged');
    const pitch = await run(email({ from: 'Rep <rep@vendor.example>', subject: 'Wholesale shampoo deal' }), sorted('other'));
    assert.equal(pitch.status, 'skipped');

    // 6. Karen hands it to the team herself: flagged, and her words are not sent.
    const handed = await run(email({ from: 'New Person <zz-new@example.com>', subject: 'Question', text: 'Can I speak to Dina about my wedding?' }),
      sorted('salon', (params) => (lastResult(params) ? say('I have passed this to the salon.')
        : use('alert_salon', { reason: 'wants_person', summary: 'Wants to talk to Dina about a wedding.' }))));
    assert.equal(handed.status, 'flagged');

    // 7. The team's own email is left for a person.
    const { rows: [staff] } = await client.query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, status, active)
       VALUES ($1, 'zz-mail-staff@example.com', 'x', 'ZZ Mail Staff', 'stylist', 'active', true) RETURNING id`, [tenant.id],
    );
    assert.ok(staff.id);
    const team = await run(email({ from: 'ZZ Mail Staff <zz-mail-staff@example.com>', subject: 'Running late' }), never);
    assert.equal(team.status, 'received');

    // 8. Switched off: filed, not answered.
    const off = await handleEmail(email({ from: 'zz-other@example.com', subject: 'Hours?' }), { ...tenant, karen_email_on: false },
      { db: client, ai: never, send, ownAddresses: [INBOX] });
    assert.equal(off.status, 'received');

    assert.equal(sends.length, 2, 'only the two answers to the client went out');
    const { rows: threads } = await client.query(
      'SELECT status FROM email_threads WHERE id = ANY($1::uuid[])', [[r1.threadId, news.threadId, hurt.threadId]],
    );
    assert.deepEqual(threads.map((x) => x.status).sort(), ['answered', 'flagged', 'skipped']);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
    if (savedKey !== undefined) process.env.RESEND_API_KEY = savedKey;
  }
});
