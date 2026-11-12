/**
 * The email check on Karen's two booking paths (2026-11-12, after QC found
 * them unchecked): a team member texting a client's email (deskBook, through
 * clientFor) and a client booking themselves by text or email (bookIt).
 * Claude is a scripted stand-in; everything runs in a transaction that is
 * rolled back. Test people are named ZZ.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { karenReply } from '../api/_lib/karen-sms.js';
import { tenantForUser } from '../api/_lib/tenant.js';
import { makeBookable } from './bookable.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const isLocal = url?.includes('localhost') || url?.includes('127.0.0.1');

function fakeClaude(script) {
  let n = 0;
  return { messages: { async create(params) { n += 1; return script(params, n); } } };
}
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const use = (name, input, id = `tu_${name}`) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });
const lastResult = (params) => {
  const last = params.messages[params.messages.length - 1];
  const block = Array.isArray(last.content) ? last.content.find((b) => b.type === 'tool_result') : null;
  return block ? { ...JSON.parse(block.content), is_error: Boolean(block.is_error) } : null;
};
const noModel = () => fakeClaude(() => { throw new Error('a yes is not for the model'); });

async function session(fn) {
  const client = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await client.connect();
  client.inTransaction = true;
  try {
    await client.query('BEGIN');
    const { rows: [t] } = await client.query("SELECT id FROM tenants WHERE slug = 'synergy'");
    const tenant = await tenantForUser({ tenant_id: t.id });
    const dina = await makeBookable(client, tenant.id, 'dina');
    await fn(client, tenant, dina);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
}

test('a team member texting a mistyped client email is asked for the right one', { skip }, async () => {
  await session(async (client, tenant, dina) => {
    const { rows: [u] } = await client.query(
      `INSERT INTO staff_users (tenant_id, name, email, role, phone, password_hash)
       VALUES ($1, 'ZZ Email Stylist', 'zz-email-stylist@example.com', 'stylist', '+1 813 555 0187', 'x') RETURNING id`,
      [tenant.id],
    );
    await client.query('UPDATE stylists SET staff_user_id = $1 WHERE id = $2', [u.id, dina]);
    let offered = null;
    const seen = {};
    const claude = fakeClaude((params, n) => {
      if (n === 1) return use('find_times', { service: 'womens-cut', stylist: 'dina' });
      if (n === 2) {
        offered = lastResult(params).times[0].start;
        return use('propose_booking', { service: 'womens-cut', stylist: 'dina', start: offered, name: 'ZZ Typo Client', client_email: 'zz-typo@gmail.conm' }, 'tu_b1');
      }
      if (n === 3) {
        seen.typo = lastResult(params);
        return use('propose_booking', { service: 'womens-cut', stylist: 'dina', start: offered, name: 'ZZ Typo Client', client_email: 'zz-typo@gmail.com' }, 'tu_b2');
      }
      seen.fixed = lastResult(params);
      return say('Book ZZ for a haircut with Dina? Reply YES to confirm.');
    });
    await karenReply(tenant, '8135550187', 'book ZZ Typo Client zz-typo@gmail.conm for a haircut with Dina', client, { ai: claude });
    assert.equal(seen.typo.is_error, true, 'the typo is refused before anything is proposed');
    assert.match(seen.typo.error, /Did you mean zz-typo@gmail\.com\?/);
    assert.equal(seen.fixed.is_error, false);

    const done = await karenReply(tenant, '8135550187', 'yes', client, { ai: noModel() });
    assert.match(done, /^All set/);
    const { rows: [a] } = await client.query("SELECT guest_email FROM appointments WHERE guest_name = 'ZZ Typo Client'");
    assert.equal(a.guest_email, 'zz-typo@gmail.com', 'booked with the corrected address');
  });
});

test('a client whose email on file has a slip is not booked to it, and is told why', { skip }, async (t) => {
  await session(async (client, tenant) => {
    if (!tenant) return t.skip('no salon');
    await client.query(
      `INSERT INTO contacts (tenant_id, name, email, phone, status)
       VALUES ($1, 'ZZ Slip Client', 'zz-slip@gmail.conm', '813-555-0186', 'booked')`,
      [tenant.id],
    );
    let offered = null;
    const claude = fakeClaude((params, n) => {
      if (n === 1) return use('find_times', { service: 'womens-cut', stylist: 'dina' });
      if (n === 2) {
        offered = lastResult(params).times[0].start;
        return use('propose_booking', { service: 'womens-cut', stylist: 'dina', start: offered, name: 'ZZ Slip Client' });
      }
      return say('A women\'s cut with Dina? Reply YES to confirm.');
    });
    await karenReply(tenant, '8135550186', 'can i book a haircut with dina', client, { ai: claude });
    const done = await karenReply(tenant, '8135550186', 'yes', client, { ai: noModel() });
    assert.match(done, /zz-slip@gmail\.conm/, 'says which address');
    assert.match(done, /doesn't look right/);
    const { rows } = await client.query("SELECT 1 FROM appointments WHERE guest_name = 'ZZ Slip Client'");
    assert.equal(rows.length, 0, 'not booked to an address that cannot receive the confirmation');
  });
});
