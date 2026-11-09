/**
 * Karen AI's histories, Select and Delete (asked for 2026-11-09), through the
 * real /api/staff/karen handler: the owner removes a conversation, a call and
 * an email record; a stylist is refused; nothing goes without confirm; and
 * rows not chosen stay.
 *
 * Everything is ZZ data on the synergy tenant, removed afterwards.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSession } from '../api/_lib/auth.js';
import { pool } from '../api/_lib/db.js';
import karen from '../api/staff/_routes/karen.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

function del(cookie, body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }); },
    };
    karen({ method: 'DELETE', url: '/api/staff/karen', body,
      headers: { cookie, host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' } }, res);
  });
}

async function cleanup(db) {
  await db.query("DELETE FROM karen_messages WHERE who_name LIKE 'ZZ Hx%' OR body LIKE 'ZZ Hx%'");
  await db.query("DELETE FROM karen_calls WHERE caller_name LIKE 'ZZ Hx%'");
  await db.query("DELETE FROM message_sends WHERE to_name LIKE 'ZZ Hx%'");
  await db.query("DELETE FROM staff_sessions WHERE user_id IN (SELECT id FROM staff_users WHERE email LIKE 'zz-hx-%@example.com')");
  await db.query("DELETE FROM staff_users WHERE email LIKE 'zz-hx-%@example.com'");
}

async function login(db, tenantId, who, role) {
  const u = (await db.query(
    `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, onboarded_at)
     VALUES ($1, $2, 'x', $3, $4, now()) RETURNING *`, [tenantId, `zz-hx-${who}@example.com`, `ZZ Hx ${who}`, role],
  )).rows[0];
  const r = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } };
  await createSession(r, u);
  return { user: u, cookie: String(r.headers['set-cookie']).split(';')[0] };
}

test('Karen AI history: the owner deletes chosen records; a stylist cannot', { skip }, async () => {
  // No ensureSchema here: run beside the other files, its ALTER TABLE can
  // queue between a test's open transaction and that test's own second
  // connection, and the suite then waits forever. The test database is
  // migrated before the suite runs (guard.js).
  const db = pool();
  await cleanup(db);
  try {
    const { rows: [t] } = await db.query("SELECT id FROM tenants WHERE slug = 'synergy'");
    const owner = await login(db, t.id, 'owner', 'owner');
    const stylist = await login(db, t.id, 'stylist', 'stylist');
    for (const u of [owner.user, stylist.user]) {
      await db.query(`INSERT INTO karen_messages (tenant_id, user_id, who_name, channel, role, body)
        VALUES ($1, $2, $3, 'app', 'user', 'ZZ Hx hello'), ($1, $2, $3, 'app', 'karen', 'ZZ Hx hi')`, [t.id, u.id, u.name]);
    }
    const calls = (await db.query(`INSERT INTO karen_calls (tenant_id, from_phone, caller_kind, caller_name)
      VALUES ($1, '+18135550301', 'unknown', 'ZZ Hx Caller 1'), ($1, '+18135550302', 'unknown', 'ZZ Hx Caller 2') RETURNING id`, [t.id])).rows;
    const mails = (await db.query(`INSERT INTO message_sends (tenant_id, kind, to_name, to_email)
      VALUES ($1, 'reminder', 'ZZ Hx Mail 1', 'zz-hx-1@example.com'), ($1, 'reminder', 'ZZ Hx Mail 2', 'zz-hx-2@example.com') RETURNING id`, [t.id])).rows;

    assert.equal((await del(stylist.cookie, { kind: 'calls', ids: [String(calls[0].id)], confirm: true })).status, 403);
    assert.equal((await del(owner.cookie, { kind: 'calls', ids: [String(calls[0].id)] })).status, 400);

    const c = await del(owner.cookie, { kind: 'chat', ids: [owner.user.id], confirm: true });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const k = await del(owner.cookie, { kind: 'calls', ids: [String(calls[0].id)], confirm: true });
    assert.equal(k.body.deleted, 1);
    const m = await del(owner.cookie, { kind: 'emails', ids: [mails[0].id, 'not-an-id'], confirm: true });
    assert.equal(m.body.deleted, 1);

    const left = async (sql, args) => (await db.query(sql, args)).rows[0].n;
    assert.equal(await left('SELECT count(*)::int n FROM karen_messages WHERE user_id = $1', [owner.user.id]), 0);
    assert.equal(await left('SELECT count(*)::int n FROM karen_messages WHERE user_id = $1', [stylist.user.id]), 2);
    assert.equal(await left("SELECT count(*)::int n FROM karen_calls WHERE caller_name LIKE 'ZZ Hx%'", []), 1);
    assert.equal(await left("SELECT count(*)::int n FROM message_sends WHERE to_name LIKE 'ZZ Hx%'", []), 1);
  } finally {
    await cleanup(db);
  }
});
