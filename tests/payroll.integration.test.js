/**
 * Payroll through Stripe (asked for 2026-11-05), driven through the real
 * handler with a stand-in for Stripe:
 *
 * - the balance is the booked value of past kept visits in their chair, and
 *   a future or cancelled visit adds nothing;
 * - no account, or an account Stripe cannot pay yet, pays nothing;
 * - Cash Me Out pays the whole balance, Partial Cashout the amount asked,
 *   never more than the balance, always to their own stored account, with
 *   the cash out's id as the idempotency key, and it is 'paid' only once the
 *   transfer read back from Stripe matches;
 * - a refusal from Stripe is 'failed' and the money is back in the balance;
 *   a read-back that does not match is never marked paid;
 * - a stylist cannot see anybody else's payouts; the owner sees the team's.
 *
 * Test rows are named ZZ and removed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';

import { createSession } from '../api/_lib/auth.js';
import { pool } from '../api/_lib/db.js';
import { ensureSchema } from '../api/_lib/ensure-schema.js';
import { setStripeTransport } from '../api/_lib/stripe.js';
import payroll from '../api/staff/_routes/payroll.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

function call(cookie, method, body) {
  return new Promise((resolve) => {
    const out = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }); },
    };
    payroll({ method, url: '/api/staff/payroll', headers: { cookie, host: 'localhost' }, body }, out);
  });
}
async function sessionFor(user) {
  const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } };
  await createSession(res, user);
  return String(res.headers['set-cookie']).split(';')[0];
}
async function cleanup(db) {
  await db.query("DELETE FROM cashout_requests WHERE staff_name LIKE 'ZZ PR %'");
  await db.query("DELETE FROM appointments WHERE ref LIKE 'ZZPR%'");
  await db.query("DELETE FROM contacts WHERE name LIKE 'ZZ PR %'");
  await db.query("UPDATE stylists SET staff_user_id = NULL WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email LIKE 'zz-pr-%')");
  await db.query("DELETE FROM stylists WHERE slug LIKE 'zz-pr-%'");
  await db.query("DELETE FROM staff_sessions WHERE user_id IN (SELECT id FROM staff_users WHERE email LIKE 'zz-pr-%')");
  await db.query("DELETE FROM staff_users WHERE email LIKE 'zz-pr-%'");
}

/** A Stripe that keeps its transfers, honours idempotency keys and can be told to refuse or lie. */
function fakeStripe() {
  const s = {
    accounts: new Map(), transfers: new Map(), byKey: new Map(), calls: [], refuse: null, lie: false, n: 0,
  };
  s.transport = async (method, path, params, headers) => {
    s.calls.push({ method, path, params, headers });
    if (method === 'POST' && path === '/accounts') {
      const id = `acct_zz${++s.n}`;
      s.accounts.set(id, { id, details_submitted: false, payouts_enabled: false, capabilities: { transfers: 'inactive' } });
      return s.accounts.get(id);
    }
    if (method === 'POST' && path === '/account_links') return { url: `https://connect.stripe.test/setup/${params.account}` };
    if (method === 'GET' && path.startsWith('/accounts/')) return s.accounts.get(decodeURIComponent(path.slice(10)));
    if (method === 'POST' && path === '/transfers') {
      if (s.refuse) { const { StripeError } = await import('../api/_lib/stripe.js'); throw new StripeError(s.refuse.message, { status: 400, code: s.refuse.code }); }
      const key = headers['Idempotency-Key'];
      if (s.byKey.has(key)) return s.transfers.get(s.byKey.get(key));
      const id = `tr_zz${++s.n}`;
      const t = { id, amount: params.amount, currency: params.currency, destination: params.destination, reversed: false, transfer_group: params.transfer_group };
      s.transfers.set(id, t);
      s.byKey.set(key, id);
      return t;
    }
    if (method === 'GET' && path.startsWith('/transfers/')) {
      const t = s.transfers.get(decodeURIComponent(path.slice(11)));
      return s.lie ? { ...t, amount: t.amount + 1 } : t;
    }
    if (method === 'GET' && path === '/transfers') {
      return { data: [...s.transfers.values()].filter((t) => t.transfer_group === params.transfer_group) };
    }
    throw new Error(`unexpected Stripe call ${method} ${path}`);
  };
  return s;
}

test('payroll: the balance, Stripe connect, Cash Me Out, Partial Cashout and every refusal', { skip }, async () => {
  await ensureSchema();
  const db = pool();
  await cleanup(db);
  const stripe = fakeStripe();
  setStripeTransport(stripe.transport);
  try {
    const { rows: [t] } = await db.query("SELECT * FROM tenants WHERE slug = 'synergy'");
    const add = async (email, name, role) => (await db.query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, onboarded_at)
       VALUES ($1, $2, 'x', $3, $4, now()) RETURNING *`, [t.id, email, name, role],
    )).rows[0];
    const owner = await add('zz-pr-owner@example.com', 'ZZ PR Owner', 'owner');
    const nina = await add('zz-pr-nina@example.com', 'ZZ PR Nina', 'stylist');
    const other = await add('zz-pr-other@example.com', 'ZZ PR Other', 'stylist');
    const chair = async (slug, userId) => (await db.query(
      'INSERT INTO stylists (tenant_id, slug, name, active, staff_user_id) VALUES ($1, $2, $2, true, $3) RETURNING id',
      [t.id, slug, userId],
    )).rows[0].id;
    const ninaChair = await chair('zz-pr-nina', nina.id);
    const otherChair = await chair('zz-pr-other', other.id);
    const { rows: [svc] } = await db.query(
      'SELECT id FROM services WHERE tenant_id = $1 AND active ORDER BY sort_order LIMIT 1', [t.id],
    );
    const { rows: [c] } = await db.query("INSERT INTO contacts (tenant_id, name, phone) VALUES ($1, 'ZZ PR Client', '8135550100') RETURNING id", [t.id]);
    const visit = async (ref, stylistId, daysFromNow, cents, status = 'completed') => {
      const start = DateTime.now().plus({ days: daysFromNow }).startOf('hour').toISO();
      await db.query(
        `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, contact_id, starts_at, duration_min, buffer_min,
                                   during, guest_name, guest_phone, manage_token, channel, price_cents, status)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, 60, 0, tstzrange($6::timestamptz, $6::timestamptz + interval '60 minutes'),
                 'ZZ PR Client', '8135550100', $7, 'staff', $8, $9::appointment_status)`,
        [t.id, ref, stylistId, svc.id, c.id, start, `tok-${ref}`, cents, status],
      );
    };
    await visit('ZZPR1', ninaChair, -3, 8000);
    await visit('ZZPR2', ninaChair, -2, 4550);
    await visit('ZZPR3', ninaChair, -1, 9900, 'cancelled');   // not earned
    await visit('ZZPR4', ninaChair, 3, 7000, 'booked');       // not yet
    await visit('ZZPR5', otherChair, -1, 50000);              // somebody else's
    const n = await sessionFor(nina);
    const o = await sessionFor(owner);

    let r = await call(n, 'GET');
    assert.equal(r.status, 200);
    assert.equal(r.body.balance.availableCents, 12550, 'two past kept visits: $80 + $45.50');
    assert.equal(r.body.stripe.configured, true);
    assert.equal(r.body.stripe.connected, false);

    // No account yet: nothing is paid, and Stripe is not asked to.
    r = await call(n, 'POST', { action: 'cashout' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'NO_ACCOUNT');
    assert.equal(stripe.calls.filter((x) => x.path === '/transfers').length, 0);

    // Connect: an Express account of her own, and Stripe's setup link.
    r = await call(n, 'POST', { action: 'connect' });
    assert.equal(r.status, 200);
    assert.match(r.body.url, /^https:\/\/connect\.stripe\.test\/setup\/acct_zz/);
    const { rows: [stored] } = await db.query('SELECT stripe_account_id FROM staff_users WHERE id = $1', [nina.id]);
    assert.match(stored.stripe_account_id, /^acct_zz/);
    const acct = stored.stripe_account_id;
    r = await call(n, 'POST', { action: 'connect' });
    assert.equal(stripe.accounts.size, 1, 'connecting again reuses her account');

    // Set up but not yet payable: still nothing moves.
    r = await call(n, 'POST', { action: 'cashout' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'NEEDS_INFO');
    Object.assign(stripe.accounts.get(acct), { details_submitted: true, payouts_enabled: true, capabilities: { transfers: 'active' } });

    // More than the balance, or nothing, is refused before Stripe is asked.
    r = await call(n, 'POST', { action: 'cashout', amount: '125.51' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'OVER_BALANCE');
    r = await call(n, 'POST', { action: 'cashout', amount: '0' });
    assert.equal(r.status, 400);
    assert.equal(stripe.calls.filter((x) => x.path === '/transfers').length, 0);

    // Partial Cashout: $25.50, to her own account, keyed by the cash out.
    r = await call(n, 'POST', { action: 'cashout', amount: '25.50', destination: 'acct_somebody_else' });
    assert.equal(r.status, 200);
    assert.equal(r.body.verified, true);
    assert.equal(r.body.amountCents, 2550);
    assert.equal(r.body.balance.availableCents, 10000);
    const sent = stripe.calls.find((x) => x.method === 'POST' && x.path === '/transfers');
    assert.equal(sent.params.destination, acct, 'the stored account, never one sent by the browser');
    assert.equal(sent.params.amount, 2550);
    assert.equal(sent.headers['Idempotency-Key'], `cashout-${r.body.id}`);
    assert.ok(stripe.calls.some((x) => x.method === 'GET' && x.path === `/transfers/${r.body.transferId}`), 'read back before it is paid');
    const { rows: [row] } = await db.query('SELECT status, stripe_transfer_id FROM cashout_requests WHERE id = $1', [r.body.id]);
    assert.deepEqual(row, { status: 'paid', stripe_transfer_id: r.body.transferId });

    // Stripe refuses (the salon's balance is short): failed, money back.
    stripe.refuse = { code: 'balance_insufficient', message: 'Insufficient funds' };
    r = await call(n, 'POST', { action: 'cashout' });
    assert.equal(r.status, 402);
    assert.match(r.body.error, /balance is too low/);
    stripe.refuse = null;
    r = await call(n, 'GET');
    assert.equal(r.body.balance.availableCents, 10000, 'a refused cash out gives the money back');
    assert.equal(r.body.history[0].status, 'failed');

    // A read-back that does not match is never marked paid.
    stripe.lie = true;
    r = await call(n, 'POST', { action: 'cashout', amount: '10' });
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'STRIPE_MISMATCH');
    stripe.lie = false;
    const { rows: [mm] } = await db.query("SELECT status FROM cashout_requests WHERE staff_user_id = $1 ORDER BY created_at DESC LIMIT 1", [nina.id]);
    assert.equal(mm.status, 'failed');

    // Cash Me Out: the whole balance, and then there is nothing left.
    r = await call(n, 'POST', { action: 'cashout' });
    assert.equal(r.status, 200);
    assert.equal(r.body.amountCents, 10000);
    assert.equal(r.body.balance.availableCents, 0);
    r = await call(n, 'POST', { action: 'cashout' });
    assert.equal(r.status, 400, 'nothing left to cash out');

    // Two at once cannot spend the same money.
    await visit('ZZPR6', ninaChair, -1, 3000);
    const both = await Promise.all([call(n, 'POST', { action: 'cashout' }), call(n, 'POST', { action: 'cashout' })]);
    assert.deepEqual(both.map((x) => x.status).sort(), [200, 400]);
    r = await call(n, 'GET');
    assert.equal(r.body.balance.paidCents, 15550);
    assert.equal(r.body.team, null, 'a stylist sees only their own payouts');
    assert.ok(r.body.history.every((h) => h.mine));

    // The owner sees the team's.
    r = await call(o, 'GET');
    assert.equal(r.status, 200);
    assert.ok(r.body.team.some((h) => h.name === 'ZZ PR Nina' && h.status === 'paid'));
  } finally {
    setStripeTransport(null);
    await cleanup(db);
  }
});
