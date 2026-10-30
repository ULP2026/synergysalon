/**
 * Karen in the app gets things done, and only when told to (asked for
 * 2026-10-31: "ask Karen to send appointment reminders to all clients
 * scheduled for today").
 *
 * Claude is a scripted stand-in and the email provider a stand-in too (no
 * key, no cost, nothing really sent). What is tested is the guarantee: she
 * only proposes; nothing is sent or changed until the person confirms that
 * exact proposal, in time; what she leaves out is said; and what happened
 * is reported from the results. Runs in a throwaway ZZ tenant and removes it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';

import { pool } from '../api/_lib/db.js';
import { confirm, dropProposal, propose } from '../api/_lib/karen-actions.js';
import { deskReply } from '../api/_lib/karen-desk.js';
import { tenantForUser } from '../api/_lib/tenant.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
const TZ = 'America/New_York';

function fakeClaude(script) {
  let n = 0;
  return { messages: { async create(params) { n += 1; return script(params, n); } } };
}
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const use = (name, input, id = `tu_${name}`) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });
const lastResult = (params) => {
  const last = params.messages.at(-1);
  const block = Array.isArray(last.content) ? last.content.find((b) => b.type === 'tool_result') : null;
  return block ? JSON.parse(block.content) : null;
};

const sent = [];
function stubProvider() {
  process.env.RESEND_API_KEY = 'zz-test';
  globalThis.__synergyResend = { emails: { async send(m) { sent.push(m); return { error: null }; } } };
}

const cleanup = () => pool().query("DELETE FROM tenants WHERE slug = 'zz-act'");

async function setup() {
  const db = pool();
  const t = (await db.query(
    "INSERT INTO tenants (slug, name, timezone) VALUES ('zz-act', 'ZZ Act', $1) RETURNING id", [TZ],
  )).rows[0];
  const user = (await db.query(
    `INSERT INTO staff_users (tenant_id, email, password_hash, name, role)
     VALUES ($1, 'zz-act-desk@example.com', 'x', 'ZZ Luis', 'owner') RETURNING *`, [t.id],
  )).rows[0];
  const tenant = await tenantForUser(user);
  await db.query(
    `INSERT INTO services (tenant_id, slug, name, category, duration_min, buffer_min)
     VALUES ($1, 'zz-cut', 'ZZ Cut', 'cuts', 60, 15)`, [t.id],
  );
  const st = (await db.query(
    "INSERT INTO stylists (tenant_id, slug, name) VALUES ($1, 'zz-dina', 'ZZ Dina') RETURNING id", [t.id],
  )).rows[0].id;
  // Three later today, one with no email address, and one cancelled.
  const soon = DateTime.now().setZone(TZ).plus({ hours: 2 }).startOf('hour');
  const add = (ref, name, email, hours, status = 'booked') => db.query(
    `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, starts_at, duration_min, buffer_min, during,
                               guest_name, guest_email, guest_phone, manage_token, channel, status)
     SELECT $1, $2, $3, v.id, $4::timestamptz, 60, 0, tstzrange($4::timestamptz, $4::timestamptz + interval '60 minutes'),
            $5, $6, '8135550101', $7, 'staff', $8::appointment_status
       FROM services v WHERE v.tenant_id = $1`,
    [t.id, ref, st, soon.plus({ hours }).toISO(), name, email, `tok-${ref}`, status],
  );
  await add('ZZACT1', 'ZZ Marian Test', 'zz-marian@example.com', 0);
  await add('ZZACT2', 'ZZ Ana Ruiz', 'zz-ana@example.com', 1);
  await add('ZZACT3', 'ZZ No Email', '', 2);
  await add('ZZACT4', 'ZZ Gone', 'zz-gone@example.com', 3, 'cancelled');
  return { tenant, user };
}

test('"send reminders to everyone today": proposed, confirmed, sent, and only then', { skip }, async () => {
  await cleanup();
  stubProvider();
  sent.length = 0;
  try {
    const { tenant, user } = await setup();
    const ctx = { tenant, user };
    const today = DateTime.now().setZone(TZ).toISODate();
    const refs = ['ZZACT1', 'ZZACT2', 'ZZACT3', 'ZZACT4'];
    let ready = null;
    const claude = fakeClaude((params, n) => {
      if (n === 1) {
        // She knows the app and today's date without being told.
        assert.match(params.system[0].text, /HOW THE SYNERGY APP WORKS/);
        assert.match(params.system[1].text, new RegExp(`Today is ${today}`));
        return use('appointments', { from_date: today, to_date: today });
      }
      if (n === 2) return use('propose_send_emails', { kind: 'reminder', refs });
      ready = lastResult(params);
      return say('Reminders for Marian and Ana are ready to send; confirm and they go.');
    });
    const out = await deskReply({
      tenant, user, question: 'can you send a email reminder to everyone scheduled today',
      history: [], propose: (input) => propose(ctx, input),
    }, claude);

    // Proposed, with what is left out and why; nothing sent yet.
    assert.equal(out.proposal.lines.length, 2);
    assert.match(out.proposal.title, /Send reminder emails to 2 clients/);
    assert.deepEqual(ready.skipped.map((x) => [x.ref, x.why]),
      [['ZZACT3', 'there is no email address on it'], ['ZZACT4', 'it is cancelled']]);
    assert.equal(sent.length, 0, 'nothing is sent by proposing');

    // A confirm for anything but this proposal does nothing (and drops it).
    const wrong = await confirm(ctx, 'not-the-id');
    assert.equal(wrong.done, false);
    assert.equal(sent.length, 0);

    // Proposed again, confirmed: both go, each recorded, and the daily run
    // will not remind them a second time.
    const again = await propose(ctx, { type: 'send_email', kind: 'reminder', refs });
    const done = await confirm(ctx, again.proposal.id);
    assert.equal(done.done, true);
    assert.match(done.say, /^Done\. I sent the reminder emails to ZZ Marian Test and ZZ Ana Ruiz\./);
    assert.deepEqual(sent.map((m) => m.to).sort(), ['zz-ana@example.com', 'zz-marian@example.com']);
    const { rows } = await pool().query(
      "SELECT ref, reminder_sent_at IS NOT NULL AS reminded FROM appointments WHERE ref IN ('ZZACT1','ZZACT2') ORDER BY ref",
    );
    assert.ok(rows.every((r) => r.reminded));
    const { rows: [{ n }] } = await pool().query(
      "SELECT count(*)::int AS n FROM message_sends WHERE tenant_id = $1 AND kind = 'reminder' AND status = 'sent'", [tenant.id],
    );
    assert.equal(n, 2);

    // The same proposal cannot be confirmed twice.
    const twice = await confirm(ctx, again.proposal.id);
    assert.equal(twice.done, false);
    assert.equal(sent.length, 2);

    // Asking again says they already had one.
    const third = await propose(ctx, { type: 'send_email', kind: 'reminder', refs: ['ZZACT1'] });
    assert.match(third.proposal.note, /already had a reminder/);
    await dropProposal(ctx);
    assert.equal((await confirm(ctx, third.proposal.id)).done, false, 'dropped when something else is said');
  } finally {
    delete process.env.RESEND_API_KEY;
    globalThis.__synergyResend = undefined;
    await cleanup();
  }
});

test('appointment actions wait for confirmation, go stale, and respect the switches', { skip }, async () => {
  await cleanup();
  stubProvider();
  sent.length = 0;
  try {
    const { tenant, user } = await setup();
    const ctx = { tenant, user };

    // Check in: proposed, nothing changes, then confirmed.
    const p = await propose(ctx, { type: 'appointment', action: 'check_in', refs: ['ZZACT1', 'ZZACT4'] });
    assert.equal(p.proposal.lines.length, 1);
    assert.equal(p.skipped[0].why, 'it is cancelled');
    let { rows: [a] } = await pool().query("SELECT checked_in_at FROM appointments WHERE ref = 'ZZACT1'");
    assert.equal(a.checked_in_at, null, 'not checked in by proposing');
    const ok = await confirm(ctx, p.proposal.id);
    assert.match(ok.say, /ZZ Marian Test at .* is checked in/);
    ({ rows: [a] } = await pool().query("SELECT checked_in_at FROM appointments WHERE ref = 'ZZACT1'"));
    assert.ok(a.checked_in_at);

    // Stale after fifteen minutes: refused, nothing done.
    const c = await propose(ctx, { type: 'appointment', action: 'cancel', refs: ['ZZACT2'] });
    await pool().query(
      `UPDATE karen_threads SET state = jsonb_set(state, '{proposal,at}', to_jsonb((now() - interval '20 minutes')::text))
        WHERE tenant_id = $1`, [tenant.id],
    );
    const stale = await confirm(ctx, c.proposal.id);
    assert.equal(stale.done, false);
    const { rows: [b] } = await pool().query("SELECT status FROM appointments WHERE ref = 'ZZACT2'");
    assert.equal(b.status, 'booked');

    // An automation switched off: nothing would go, so nothing is proposed.
    const off = await propose({ tenant: { ...tenant, automations_off: ['reminder'] }, user },
      { type: 'send_email', kind: 'reminder', refs: ['ZZACT2'] });
    assert.equal(off.nothing, true);
    assert.match(off.reason, /switched off in Settings, Automations/);

    // Only the listed actions and emails exist: no deleting, no other email.
    assert.ok((await propose(ctx, { type: 'appointment', action: 'delete', refs: ['ZZACT2'] })).error);
    assert.ok((await propose(ctx, { type: 'send_email', kind: 'win_back', refs: ['ZZACT2'] })).error);
  } finally {
    delete process.env.RESEND_API_KEY;
    globalThis.__synergyResend = undefined;
    await cleanup();
  }
});

test('a booking request is handed to the booking steps', { skip }, async () => {
  await cleanup();
  try {
    const { tenant, user } = await setup();
    const claude = fakeClaude((params, n) => (n === 1
      ? use('start_booking', { request: 'a cut with Dina on Friday' })
      : say("Let's get that booked.")));
    const out = await deskReply({ tenant, user, question: 'book Marian a cut with Dina friday', history: [] }, claude);
    assert.deepEqual(out.handoff, { type: 'book', request: 'a cut with Dina on Friday' });
    assert.equal(out.proposal, null);
  } finally {
    await cleanup();
    await pool().end();
    globalThis.__synergyPool = undefined;
  }
});
