/**
 * Karen in the app answers the team's questions from the records, and only
 * reads them.
 *
 * Claude is a scripted stand-in here (no key, no cost): what is tested is
 * what each look-up hands the model, and that none of them can write. Runs
 * in a transaction that is rolled back; test people are named ZZ.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { DateTime } from 'luxon';
import pg from 'pg';

import { DEFAULT_TZ } from '../api/_lib/config.js';
import { deskReply } from '../api/_lib/karen-desk.js';
import { tenantForUser } from '../api/_lib/tenant.js';
import { makeBookable } from './bookable.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const isLocal = url?.includes('localhost') || url?.includes('127.0.0.1');

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
  return block ? { ...JSON.parse(block.content), is_error: Boolean(block.is_error) } : null;
};

test('Karen in the app reads clients, their history, the calendar and the email log', { skip }, async () => {
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
      `INSERT INTO contacts (tenant_id, name, email, phone, source, status, notes, created_at)
       VALUES ($1, 'ZZ Desk Client', 'zz-desk@example.com', '813-555-0199', 'Facebook', 'booked',
               'Oct 30, 2026, RJ: Prefers mornings', now() - interval '2 days') RETURNING id`,
      [tenant.id],
    );
    const start = DateTime.now().setZone(DEFAULT_TZ).plus({ days: 3 }).startOf('day').set({ hour: 11 });
    const { rows: [a] } = await client.query(
      `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, contact_id, starts_at, duration_min,
                                 buffer_min, during, guest_name, guest_email, manage_token)
       VALUES ($1, 'ZZDESK1', $2, $3, $4, $5::timestamptz, $6, 0,
               tstzrange($5::timestamptz, $5::timestamptz + make_interval(mins => $6::int), '[)'),
               'ZZ Desk Client', 'zz-desk@example.com', 'tok-ZZDESK1') RETURNING id`,
      [tenant.id, stylistId, svc.id, c.id, start.toISO(), svc.duration_min],
    );
    await client.query(
      `INSERT INTO message_sends (tenant_id, kind, appointment_id, to_name, to_email, sent_at)
       VALUES ($1, 'reminder', $2, 'ZZ Desk Client', 'zz-desk@example.com', now() - interval '1 hour')`,
      [tenant.id, a.id],
    );
    const before = (await client.query('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1', [tenant.id])).rows[0].n;

    const seen = {};
    const claude = fakeClaude((params, n) => {
      if (n === 1) {
        // The question and the salon's clock reach the model.
        assert.equal(params.messages.at(-1).content, 'When was ZZ Desk Client added, and have we emailed them?');
        assert.match(params.system[1].text, /Right now it is/);
        return use('find_clients', { search: 'zz desk' });
      }
      if (n === 2) {
        seen.find = lastResult(params);
        return use('find_clients', { search: '0199' }, 'tu_phone');
      }
      if (n === 3) {
        seen.phone = lastResult(params);
        return use('client_history', { client_id: seen.find.clients[0].id });
      }
      if (n === 4) {
        seen.history = lastResult(params);
        const day = start.toISODate();
        return use('appointments', { from_date: day, to_date: day, stylist: 'dina' });
      }
      if (n === 5) {
        seen.appts = lastResult(params);
        return use('emails_sent', { kind: 'reminder', client_id: seen.find.clients[0].id });
      }
      if (n === 6) {
        seen.emails = lastResult(params);
        return use('client_history', { client_id: 'not-an-id' }, 'tu_bad');
      }
      seen.bad = lastResult(params);
      return say('ZZ Desk Client was added two days ago from Facebook, and was sent a reminder an hour ago.');
    });

    const answer = await deskReply({
      tenant, user: { name: 'ZZ Front Desk', role: 'front_desk' },
      question: 'When was ZZ Desk Client added, and have we emailed them?', history: [],
    }, claude, client);

    assert.match(answer.say, /ZZ Desk Client was added/);
    assert.equal(seen.find.total, 1);
    assert.equal(seen.find.clients[0].name, 'ZZ Desk Client');
    assert.equal(seen.find.clients[0].source, 'Facebook');
    assert.ok(seen.find.clients[0].added, 'when they were added');
    assert.equal(seen.find.clients[0].stylist, 'Dina Lara');
    assert.equal(seen.phone.total, 1, 'found by phone digits');
    assert.equal(seen.history.client.notes, 'Oct 30, 2026, RJ: Prefers mornings');
    assert.equal(seen.history.appointments[0].ref, 'ZZDESK1');
    assert.equal(seen.history.emails_sent.length, 1);
    assert.equal(seen.history.emails_sent[0].kind, 'reminder');
    assert.ok(seen.history.activity.some((e) => /^Booked/.test(e.what)));
    assert.ok(seen.appts.appointments.some((x) => x.ref === 'ZZDESK1' && x.client === 'ZZ Desk Client'));
    assert.equal(seen.emails.count, 1);
    assert.equal(seen.bad.is_error, true, 'a made-up id is refused, not looked up');
    // It read; nothing was written.
    const after = (await client.query('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1', [tenant.id])).rows[0].n;
    assert.equal(after, before);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});

test('Karen in the app has no tool that can write', () => {
  const src = readFileSync(new URL('../api/_lib/karen-desk.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/);
  assert.doesNotMatch(src, /send(Message|Reminder|Email)|createBooking|mirrorToGoogle/);
});
