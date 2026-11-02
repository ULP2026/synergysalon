/**
 * Karen's Call History (2026-11-02): a call is kept when it is greeted, with
 * who called, and the salon line's answer is added when the <Dial> ends.
 *
 * Skips without DATABASE_URL. Runs in a throwaway ZZ tenant and removes it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { pool } from '../api/_lib/db.js';
import { karenCalls, logCallEnd, logCallStart } from '../api/_lib/karen-calls.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
const cleanup = () => pool().query("DELETE FROM tenants WHERE slug = 'zz-calls'");

test('calls are kept newest first, with the caller and how the salon answered', { skip }, async () => {
  await cleanup();
  const db = pool();
  try {
    const t = (await db.query("INSERT INTO tenants (slug, name, timezone) VALUES ('zz-calls', 'ZZ Calls', 'America/New_York') RETURNING id")).rows[0];
    const c = (await db.query("INSERT INTO contacts (tenant_id, name, phone) VALUES ($1, 'ZZ Caller', '8135550111') RETURNING id", [t.id])).rows[0];
    await logCallStart(t.id, { sid: 'CAzz1', from: '+18135550111', who: { kind: 'client', id: c.id, name: 'ZZ Caller' }, forwardedTo: '+18136542055' });
    // The same call posted twice is kept once.
    await logCallStart(t.id, { sid: 'CAzz1', from: '+18135550111', who: { kind: 'client', id: c.id, name: 'ZZ Caller' }, forwardedTo: '+18136542055' });
    await logCallEnd(t.id, { sid: 'CAzz1', status: 'completed', duration: '75' });
    await new Promise((r) => setTimeout(r, 5));
    await logCallStart(t.id, { sid: 'CAzz2', from: '+18135550999', who: { kind: 'unknown' }, forwardedTo: null });

    const calls = await karenCalls(t.id);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].phone, '+18135550999', 'newest first');
    assert.equal(calls[0].kind, 'unknown');
    assert.equal(calls[0].forwarded, false);
    assert.equal(calls[1].name, 'ZZ Caller');
    assert.equal(calls[1].kind, 'client');
    assert.equal(calls[1].contactId, c.id);
    assert.equal(calls[1].status, 'completed');
    assert.equal(calls[1].durationSec, 75);
  } finally {
    await cleanup();
  }
});
