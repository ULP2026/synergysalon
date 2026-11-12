/**
 * Connect with Stripe (Synergy App 1.0, 2026-11-13), driven through the
 * real handler with a stand-in for Stripe:
 *
 * - only the owner or an admin is sent to Stripe's sign-in, and the link
 *   names the app's Connect client, a signed state and this endpoint;
 * - coming back, a forged or stale state, or somebody else signed in, links
 *   nothing; a good one swaps the code, reads the account back, and keeps
 *   only its id; a cancel says so and keeps nothing;
 * - Settings reads the account's name and whether it can take payments;
 * - Disconnect is the owner's, unlinks it at Stripe and forgets it;
 * - Payroll's payouts stay off when the platform's key is set.
 *
 * Test logins are named ZZ and removed; the salon's own Stripe columns are
 * put back as they were.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSession } from '../api/_lib/auth.js';
import { pool } from '../api/_lib/db.js';
import { ensureSchema } from '../api/_lib/ensure-schema.js';
import { payoutsOn, setStripeTransport } from '../api/_lib/stripe.js';
import stripeRoute, { makeState, readState } from '../api/staff/_routes/stripe.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

function call(cookie, method, url, body) {
  return new Promise((resolve) => {
    const out = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      end(text) {
        resolve({ status: this.statusCode, location: this.headers.location || null, body: text ? JSON.parse(text) : null });
      },
    };
    stripeRoute({ method, url, headers: { cookie, host: 'localhost' }, body }, out);
  });
}
async function sessionFor(user) {
  const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } };
  await createSession(res, user);
  return String(res.headers['set-cookie']).split(';')[0];
}
async function cleanup(db) {
  await db.query("DELETE FROM staff_sessions WHERE user_id IN (SELECT id FROM staff_users WHERE email LIKE 'zz-sst-%')");
  await db.query("DELETE FROM staff_users WHERE email LIKE 'zz-sst-%'");
}
const outcome = (r) => new URL(r.location).searchParams.get('salon-stripe');

test('the state is signed, names the person and the salon, and runs out', () => {
  const key = process.env.TOKEN_KEY;
  process.env.TOKEN_KEY = 'zz-test-signing-key-123456';
  try {
    const user = { id: 'u1', tenant_id: 't1' };
    const st = makeState(user, 1_000_000);
    assert.deepEqual(readState(st, 1_000_000 + 60_000), { userId: 'u1', tenantId: 't1' });
    assert.equal(readState(st, 1_000_000 + 16 * 60_000), null, 'stale after 15 minutes');
    assert.equal(readState(st.replace('u1', 'u2'), 1_000_000), null, 'another person');
    assert.equal(readState('a.b.c', 1_000_000), null);
  } finally {
    if (key === undefined) delete process.env.TOKEN_KEY; else process.env.TOKEN_KEY = key;
  }
});

test('payroll payouts stay off with the platform key alone', () => {
  const saved = { ...process.env };
  try {
    setStripeTransport(null);
    process.env.STRIPE_SECRET_KEY = 'sk_test_zz';
    delete process.env.STRIPE_PAYOUTS;
    assert.equal(payoutsOn(), false);
    process.env.STRIPE_PAYOUTS = 'on';
    assert.equal(payoutsOn(), true);
  } finally {
    for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_PAYOUTS']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

test('Connect with Stripe: the owner links the salon\'s account, and nobody else can', { skip }, async () => {
  await ensureSchema();
  const db = pool();
  await cleanup(db);
  const key = process.env.TOKEN_KEY;
  process.env.TOKEN_KEY ||= 'zz-test-signing-key-123456';
  const calls = [];
  setStripeTransport(async (method, path, params) => {
    calls.push({ method, path, params });
    if (path === 'connect:/oauth/token') {
      if (params.code !== 'ac_zz_good') {
        const { StripeError } = await import('../api/_lib/stripe.js');
        throw new StripeError('Authorization code does not exist', { status: 400, code: 'invalid_grant' });
      }
      return { stripe_user_id: 'acct_zz_salon', livemode: false, access_token: 'sk_never_kept' };
    }
    if (method === 'GET' && path === '/accounts/acct_zz_salon') {
      return { id: 'acct_zz_salon', email: 'zz-salon@example.com', charges_enabled: true, details_submitted: true,
        settings: { dashboard: { display_name: 'ZZ Salon' } } };
    }
    if (path === 'connect:/oauth/deauthorize') return { stripe_user_id: params.stripe_user_id };
    throw new Error(`unexpected Stripe call ${method} ${path}`);
  });
  const { rows: [t] } = await db.query(
    `SELECT id, to_jsonb(tenants) - 'hours' AS row FROM tenants WHERE slug = 'synergy'`,
  );
  const before = t.row;
  try {
    const add = async (email, name, role) => (await db.query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, onboarded_at)
       VALUES ($1, $2, 'x', $3, $4, now()) RETURNING *`, [t.id, email, name, role],
    )).rows[0];
    const owner = await add('zz-sst-owner@example.com', 'ZZ SST Owner', 'owner');
    const stylist = await add('zz-sst-nina@example.com', 'ZZ SST Nina', 'stylist');
    const ownerCookie = await sessionFor(owner);
    const stylistCookie = await sessionFor(stylist);
    await db.query('UPDATE tenants SET stripe_account_id = NULL WHERE id = $1', [t.id]);

    // A stylist is not sent to Stripe.
    const no = await call(stylistCookie, 'GET', '/api/staff/stripe?start=1');
    assert.equal(no.status, 302);
    assert.equal(outcome(no), 'error');
    assert.match(no.location, /\/staff\/settings\?tab=money/);

    // The owner is, with the client, a signed state and this endpoint.
    const go = await call(ownerCookie, 'GET', '/api/staff/stripe?start=1');
    const to = new URL(go.location);
    assert.equal(to.origin + to.pathname, 'https://connect.stripe.com/oauth/authorize');
    assert.equal(to.searchParams.get('scope'), 'read_write');
    assert.equal(to.searchParams.get('redirect_uri'), 'http://localhost/api/staff/stripe');
    const state = to.searchParams.get('state');
    assert.ok(readState(state));

    const stored = async () => (await db.query(
      "SELECT to_jsonb(t) ->> 'stripe_account_id' AS acct FROM tenants t WHERE id = $1", [t.id])).rows[0].acct;

    // Forged state, or the wrong person back: nothing linked, nothing asked of Stripe.
    const forged = await call(ownerCookie, 'GET', `/api/staff/stripe?code=ac_zz_good&state=${encodeURIComponent(`${state}x`)}`);
    assert.equal(outcome(forged), 'error');
    const wrong = await call(stylistCookie, 'GET', `/api/staff/stripe?code=ac_zz_good&state=${encodeURIComponent(state)}`);
    assert.equal(outcome(wrong), 'error');
    assert.equal(calls.length, 0);
    assert.equal(await stored(), null);

    // Cancelled on Stripe's page.
    const cancel = await call(ownerCookie, 'GET', '/api/staff/stripe?error=access_denied&state=x');
    assert.equal(outcome(cancel), 'cancelled');

    // A used code: said plainly, nothing kept.
    const used = await call(ownerCookie, 'GET', `/api/staff/stripe?code=ac_zz_used&state=${encodeURIComponent(state)}`);
    assert.equal(outcome(used), 'error');
    assert.match(new URL(used.location).searchParams.get('why'), /already used or ran out/);
    assert.equal(await stored(), null);

    // The real thing.
    const back = await call(ownerCookie, 'GET', `/api/staff/stripe?code=ac_zz_good&state=${encodeURIComponent(state)}`);
    assert.equal(outcome(back), 'connected');
    assert.equal(await stored(), 'acct_zz_salon');
    const { rows: [row] } = await db.query('SELECT to_jsonb(t)::text AS j FROM tenants t WHERE id = $1', [t.id]);
    assert.doesNotMatch(row.j, /sk_never_kept/, 'Stripe\'s keys for the account are not kept');

    // Settings: the owner reads it, a stylist cannot.
    const status = await call(ownerCookie, 'GET', '/api/staff/stripe');
    assert.equal(status.status, 200);
    assert.equal(status.body.connected, true);
    assert.equal(status.body.name, 'ZZ Salon');
    assert.equal(status.body.chargesEnabled, true);
    assert.equal(status.body.connectedBy, 'ZZ SST Owner');
    assert.equal(status.body.livemode, false);
    assert.equal((await call(stylistCookie, 'GET', '/api/staff/stripe')).status, 403);

    // Disconnect: not a stylist's; the owner's unlinks it at Stripe too.
    assert.equal((await call(stylistCookie, 'POST', '/api/staff/stripe', { action: 'disconnect' })).status, 403);
    assert.equal(await stored(), 'acct_zz_salon');
    const off = await call(ownerCookie, 'POST', '/api/staff/stripe', { action: 'disconnect' });
    assert.equal(off.status, 200);
    assert.equal(off.body.connected, false);
    assert.ok(calls.some((c) => c.path === 'connect:/oauth/deauthorize' && c.params.stripe_user_id === 'acct_zz_salon'));
    assert.equal(await stored(), null);
  } finally {
    setStripeTransport(null);
    if (key === undefined) delete process.env.TOKEN_KEY; else process.env.TOKEN_KEY = key;
    await db.query(
      `UPDATE tenants SET stripe_account_id = $2, stripe_livemode = $3::boolean,
              stripe_connected_at = $4::timestamptz, stripe_connected_by = $5::uuid WHERE id = $1`,
      [t.id, before.stripe_account_id ?? null, before.stripe_livemode ?? null,
        before.stripe_connected_at ?? null, before.stripe_connected_by ?? null],
    );
    await cleanup(db);
  }
});
