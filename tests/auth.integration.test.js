/**
 * Staff sessions against a real database.
 *
 * Creates its own throwaway user, exercises the session lifecycle, and removes
 * it again. Skips entirely without DATABASE_URL.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { createSession, currentUser, destroySession } from '../api/_lib/auth.js';
import { pool, query } from '../api/_lib/db.js';
import { hashPassword, verifyPassword } from '../api/_lib/password.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

const EMAIL = 'zz-test-staff@example.invalid';
const PASSWORD = 'a test password nobody uses';

/** Minimal stand-ins for the Node request and response the helpers expect. */
function fakeRes() {
  const headers = {};
  return {
    headers,
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    cookie() {
      const set = headers['set-cookie'] || '';
      return set.split(';')[0];
    },
  };
}
const fakeReq = (cookie = '', extra = {}) => ({ headers: { cookie, ...extra } });

async function makeUser() {
  const { rows: [tenant] } = await query('SELECT id FROM tenants ORDER BY created_at LIMIT 1');
  assert.ok(tenant, 'no tenant exists; run npm run db:setup first');
  const { rows } = await query(
    `INSERT INTO staff_users (tenant_id, email, password_hash, name, role)
     VALUES ($1, $2, $3, 'ZZ Test', 'front_desk')
     ON CONFLICT (tenant_id, lower(email)) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, active = true,
           failed_attempts = 0, locked_until = NULL
     RETURNING id, tenant_id, email, name, role`,
    [tenant.id, EMAIL, await hashPassword(PASSWORD)],
  );
  return rows[0];
}

async function cleanup() {
  await query('DELETE FROM staff_users WHERE lower(email) = $1', [EMAIL]).catch(() => {});
}

after(async () => {
  if (!skip) {
    await cleanup();
    await pool().end().catch(() => {});
  }
});

test('a session signs a user in and back out', { skip }, async () => {
  const user = await makeUser();
  const res = fakeRes();
  await createSession(res, user, 'node-test');

  const cookieHeader = res.headers['set-cookie'];
  assert.match(cookieHeader, /HttpOnly/, 'the cookie must not be readable from JavaScript');
  assert.match(cookieHeader, /SameSite=Lax/);

  const signedIn = await currentUser(fakeReq(res.cookie()));
  assert.equal(signedIn?.email, EMAIL);
  assert.equal(signedIn?.tenant_id, user.tenant_id);

  await destroySession(fakeReq(res.cookie()), fakeRes());
  assert.equal(await currentUser(fakeReq(res.cookie())), null, 'a destroyed session is gone');
});

test('only the hash of the token is stored', { skip }, async () => {
  const user = await makeUser();
  const res = fakeRes();
  await createSession(res, user, 'node-test');
  const token = res.cookie().split('=')[1];

  const { rows } = await query(
    'SELECT token_hash FROM staff_sessions WHERE user_id = $1', [user.id],
  );
  assert.ok(rows.length);
  for (const row of rows) {
    assert.notEqual(row.token_hash, token,
      'a leaked backup must not contain anything replayable as a login');
  }
});

test('an expired session does not sign anyone in', { skip }, async () => {
  const user = await makeUser();
  const res = fakeRes();
  await createSession(res, user, 'node-test');

  await query(
    "UPDATE staff_sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1",
    [user.id],
  );
  assert.equal(await currentUser(fakeReq(res.cookie())), null);
});

test('a deactivated user cannot use an existing session', { skip }, async () => {
  const user = await makeUser();
  const res = fakeRes();
  await createSession(res, user, 'node-test');

  // Someone leaves. Their laptop still has a valid cookie.
  await query('UPDATE staff_users SET active = false WHERE id = $1', [user.id]);
  assert.equal(await currentUser(fakeReq(res.cookie())), null,
    'revoking access has to take effect without waiting for the session to expire');
});

test('a password stored by create-staff verifies', { skip }, async () => {
  const user = await makeUser();
  const { rows } = await query('SELECT password_hash FROM staff_users WHERE id = $1', [user.id]);
  assert.equal(await verifyPassword(PASSWORD, rows[0].password_hash), true);
  assert.equal(await verifyPassword('not the password', rows[0].password_hash), false);
});

test('no session at all is simply nobody', { skip }, async () => {
  assert.equal(await currentUser(fakeReq('')), null);
  assert.equal(await currentUser(fakeReq('synergy_staff=nonsense')), null);
});
