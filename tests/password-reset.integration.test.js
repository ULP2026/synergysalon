/**
 * Forgot Password? (asked for 2026-11-06), through the real handler:
 *
 * - asking answers the same for an address with an account and one without;
 * - a link is made only for an active login, kept only as a hash, and works
 *   once, for an hour;
 * - a new password must be long enough, works for signing in, and signs out
 *   every session that had the old one;
 * - a used, expired or made-up link is refused with the same words.
 *
 * No email provider in the tests, so nothing is sent. ZZ rows, removed.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createSession } from '../api/_lib/auth.js';
import { pool } from '../api/_lib/db.js';
import { ensureSchema } from '../api/_lib/ensure-schema.js';
import { verifyPassword } from '../api/_lib/password.js';
import reset, { SENT, requestReset } from '../api/staff/_routes/reset.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

function call(method, { body, query = '' } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }); },
    };
    reset({ method, url: `/api/staff/reset?salon=synergy${query}`, headers: { host: 'localhost' }, body }, res);
  });
}
const tokenOf = (link) => new URL(link).searchParams.get('t');
const settle = () => new Promise((r) => setTimeout(r, 400));

async function cleanup(db) {
  await db.query("DELETE FROM staff_sessions WHERE user_id IN (SELECT id FROM staff_users WHERE email LIKE 'zz-reset-%')");
  await db.query("DELETE FROM staff_users WHERE email LIKE 'zz-reset-%'");
}

test('Forgot Password: same answer for anyone, a one-hour single-use link, sessions ended', { skip }, async () => {
  await ensureSchema();
  const db = pool();
  await cleanup(db);
  try {
    const { rows: [t] } = await db.query("SELECT * FROM tenants WHERE slug = 'synergy'");
    const add = async (email, status) => (await db.query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, status, onboarded_at)
       VALUES ($1, $2, 'x', 'ZZ Reset Person', 'stylist', $3::staff_status, now()) RETURNING *`, [t.id, email, status],
    )).rows[0];
    const user = await add('zz-reset-stylist@example.com', 'active');
    await add('zz-reset-pending@example.com', 'pending');
    const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } };
    await createSession(res, user);
    assert.equal((await db.query('SELECT count(*)::int n FROM staff_sessions WHERE user_id = $1', [user.id])).rows[0].n, 1);

    // The answer gives nothing away.
    const known = await call('POST', { body: { action: 'request', email: 'ZZ-Reset-Stylist@example.com' } });
    const unknown = await call('POST', { body: { action: 'request', email: 'zz-reset-nobody@example.com' } });
    assert.equal(known.status, 200);
    assert.deepEqual(known.body, unknown.body);
    assert.equal(known.body.message, SENT);
    await settle();
    const stored = (await db.query('SELECT reset_hash, reset_expires_at FROM staff_users WHERE id = $1', [user.id])).rows[0];
    assert.ok(stored.reset_hash, 'a link was made for the account');
    const mins = (new Date(stored.reset_expires_at) - Date.now()) / 60000;
    assert.ok(mins > 55 && mins <= 60, 'it lasts an hour');
    // Waiting for approval: nothing made.
    assert.equal((await requestReset({ headers: { host: 'localhost' } }, t, 'zz-reset-pending@example.com')).sent, false);
    // Asked again at once: spaced out, the first link stands.
    assert.equal((await requestReset({ headers: { host: 'localhost' } }, t, 'zz-reset-stylist@example.com')).sent, false);

    // A link of our own, to follow (the one emailed is never seen here).
    await db.query('UPDATE staff_users SET reset_requested_at = NULL WHERE id = $1', [user.id]);
    const made = await requestReset({ headers: { host: 'app.synergysalon.com' } }, t, 'zz-reset-stylist@example.com');
    assert.equal(made.sent, true);
    assert.match(made.link, /^https:\/\/app\.synergysalon\.com\/reset\?t=[A-Za-z0-9_-]{40,}$/);
    const token = tokenOf(made.link);
    const kept = (await db.query('SELECT reset_hash FROM staff_users WHERE id = $1', [user.id])).rows[0].reset_hash;
    assert.equal(kept, createHash('sha256').update(token).digest('hex'), 'only its hash is kept');
    assert.ok(!kept.includes(token));

    let r = await call('GET', { query: `&t=${token}` });
    assert.equal(r.status, 200);
    assert.equal(r.body.email, 'zz-reset-stylist@example.com');

    r = await call('POST', { body: { action: 'reset', t: token, password: 'short' } });
    assert.equal(r.status, 400, 'too short is refused');
    r = await call('POST', { body: { action: 'reset', t: token, password: 'zz-a-new-password-1' } });
    assert.equal(r.status, 200);
    const after = (await db.query('SELECT password_hash, reset_hash FROM staff_users WHERE id = $1', [user.id])).rows[0];
    assert.ok(await verifyPassword('zz-a-new-password-1', after.password_hash), 'the new password signs in');
    assert.equal(after.reset_hash, null);
    assert.equal((await db.query('SELECT count(*)::int n FROM staff_sessions WHERE user_id = $1', [user.id])).rows[0].n, 0,
      'every session with the old password is ended');

    // Spent, made up, or out of time: the same refusal.
    const used = await call('POST', { body: { action: 'reset', t: token, password: 'zz-another-password-2' } });
    const fake = await call('GET', { query: '&t=zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' });
    assert.equal(used.status, 410);
    assert.equal(fake.status, 410);
    assert.equal(used.body.error, fake.body.error);
    await db.query('UPDATE staff_users SET reset_requested_at = NULL WHERE id = $1', [user.id]);
    const late = await requestReset({ headers: { host: 'localhost' } }, t, 'zz-reset-stylist@example.com');
    await db.query("UPDATE staff_users SET reset_expires_at = now() - interval '1 minute' WHERE id = $1", [user.id]);
    assert.equal((await call('GET', { query: `&t=${tokenOf(late.link)}` })).status, 410, 'an hour on, the link is dead');
  } finally {
    await cleanup(db);
  }
});
