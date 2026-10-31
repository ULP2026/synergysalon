/**
 * Karen's message history: what the team says to her, in the app or by
 * text, is kept by person for the owner's Message History, and only the
 * admin can read it. A client's texts are not part of it.
 *
 * Runs in a transaction that is rolled back; test people are named ZZ. The
 * texted replies come from her rules (no model, no cost).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import pg from 'pg';

import { karenPeople, karenThread, logKaren } from '../api/_lib/karen-log.js';
import { karenReply } from '../api/_lib/karen-sms.js';
import { tenantForUser } from '../api/_lib/tenant.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const isLocal = url?.includes('localhost') || url?.includes('127.0.0.1');

test('the team\'s messages with Karen are kept by person, in order', { skip }, async () => {
  const client = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await client.connect();
  client.inTransaction = true;
  try {
    await client.query('BEGIN');
    const { rows: [t] } = await client.query("SELECT id FROM tenants WHERE slug = 'synergy'");
    const tenant = await tenantForUser({ tenant_id: t.id });
    // Only what this test writes is looked at.
    await client.query('DELETE FROM karen_messages WHERE tenant_id = $1', [tenant.id]);
    const { rows: [stylist] } = await client.query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, phone, status)
       VALUES ($1, 'zz-karen-hist@example.com', 'x', 'ZZ History Stylist', 'stylist', '8135550177', 'active') RETURNING id, name`,
      [tenant.id],
    );
    const { rows: [desk] } = await client.query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, status)
       VALUES ($1, 'zz-karen-hist2@example.com', 'x', 'ZZ History Desk', 'front_desk', 'active') RETURNING id, name`,
      [tenant.id],
    );

    // In the app: what the chat window showed, in the order it happened.
    const t0 = Date.now() - 60_000;
    assert.equal(await logKaren(tenant.id, stylist, 'app', [
      { role: 'user', text: 'what is on my schedule today?', at: new Date(t0).toISOString() },
      { role: 'karen', text: 'Nothing booked today.', at: new Date(t0 + 1000).toISOString() },
      { role: 'robot', text: 'not a role' },
      { role: 'user', text: '   ' },
    ], client), 2, 'only real messages are kept');
    await logKaren(tenant.id, desk, 'app', [{ role: 'user', text: 'hi Karen' }], client);

    // By text: a team member's conversation is kept; a client's is not.
    const reply = await karenReply(tenant, '(813) 555-0177', 'today', client, { ai: null });
    assert.ok(reply, 'Karen answered the text');
    await karenReply(tenant, '8135550999', 'hello', client, { ai: null });

    const people = await karenPeople(tenant.id, client);
    assert.deepEqual(people.map((p) => p.name).sort(), ['ZZ History Desk', 'ZZ History Stylist']);
    const mine = people.find((p) => p.id === stylist.id);
    assert.equal(mine.messages, 4);
    assert.deepEqual(mine.channels.sort(), ['app', 'text']);

    const thread = await karenThread(tenant.id, stylist.id, client);
    assert.deepEqual(thread.map((m) => [m.channel, m.role]), [
      ['app', 'user'], ['app', 'karen'], ['text', 'user'], ['text', 'karen'],
    ]);
    assert.equal(thread[0].text, 'what is on my schedule today?');
    assert.equal(thread[2].text, 'today');
    assert.equal(thread[3].text, reply, 'the text kept is the one sent');
    // Nobody unknown, and nothing for a made-up id.
    assert.deepEqual(await karenThread(tenant.id, 'not-an-id', client), []);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});

test('only the admin can read Message History', () => {
  const src = readFileSync(new URL('../api/staff/_routes/karen.js', import.meta.url), 'utf8');
  const get = src.slice(src.indexOf('async GET('), src.indexOf('async POST('));
  // The history is read behind the admin check, before anything else.
  assert.ok(get.indexOf('requireTeamAdmin(req)') > -1 && get.indexOf('requireTeamAdmin(req)') < get.indexOf('karenPeople('));
  // Writing is always as the person signed in.
  assert.match(src, /logKaren\(user\.tenant_id, user, 'app', body\.log\)/);
});
