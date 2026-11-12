/**
 * Karen's special instructions (Rec 2e, 2026-11-12): what the owner writes
 * on Settings, Karen AI reaches her prompt by text (karen-ai.js through
 * karen-sms.js) and in the app (karen-desk.js), after her own rules and
 * framed as notes that cannot change them. With none written, no block is
 * added. Claude is a stand-in that records what it was sent; everything runs
 * in a transaction that is rolled back.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { cleanInstructions, instructionsBlock, KAREN_INSTRUCTIONS_MAX } from '../api/_lib/karen-instructions.js';
import { deskReply } from '../api/_lib/karen-desk.js';
import { karenReply } from '../api/_lib/karen-sms.js';
import { ensureSchema } from '../api/_lib/ensure-schema.js';
import { tenantForUser } from '../api/_lib/tenant.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const isLocal = url?.includes('localhost') || url?.includes('127.0.0.1');
const NOTE = 'ZZ: ask every new client how they heard about us.';

/** A stand-in Claude that answers once and keeps the system prompt it got. */
function recorder() {
  const seen = [];
  return {
    seen,
    messages: { async create(params) { seen.push(params.system.map((b) => b.text).join('\n---\n')); return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hi!' }] }; } },
  };
}

test('the box is trimmed and capped, and empty adds nothing', () => {
  assert.equal(cleanInstructions('  hello \r\n there  '), 'hello \n there');
  assert.equal(cleanInstructions('x'.repeat(KAREN_INSTRUCTIONS_MAX + 50)).length, KAREN_INSTRUCTIONS_MAX);
  assert.equal(instructionsBlock('   '), null);
  const block = instructionsBlock(NOTE);
  assert.match(block.text, /never change the rules above/);
  assert.match(block.text, /<instructions>\nZZ: ask every new client/);
});

test('both Karens read the owner\'s instructions, and only when there are some', { skip }, async () => {
  const client = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await client.connect();
  client.inTransaction = true;
  try {
    // The column first, outside the transaction: an ALTER inside it would
    // lock tenants against the code's own connection and hang the test.
    await ensureSchema();
    await client.query('BEGIN');
    const { rows: [t] } = await client.query("SELECT id FROM tenants WHERE slug = 'synergy'");
    const tenant = await tenantForUser({ tenant_id: t.id });
    await client.query('UPDATE tenants SET karen_instructions = NULL WHERE id = $1', [t.id]);

    const none = recorder();
    await karenReply(tenant, '8135550184', 'hi, what are your hours?', client, { ai: none });
    assert.ok(none.seen.length, 'the model was asked');
    assert.doesNotMatch(none.seen[0], /special instructions for you/, 'no block when the box is empty');

    await client.query('UPDATE tenants SET karen_instructions = $2 WHERE id = $1', [t.id, NOTE]);
    const bySms = recorder();
    await karenReply(tenant, '8135550183', 'hi, what are your hours?', client, { ai: bySms });
    assert.match(bySms.seen[0], /special instructions for you[\s\S]*ZZ: ask every new client/);
    assert.ok(bySms.seen[0].indexOf('ZZ: ask') > bySms.seen[0].indexOf('Your personality'), 'after her own rules');

    const inApp = recorder();
    await deskReply({ tenant, user: { name: 'ZZ Owner', role: 'owner' }, question: 'Anything I should know?', history: [] }, inApp, client);
    assert.match(inApp.seen[0], /special instructions for you[\s\S]*ZZ: ask every new client/);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
