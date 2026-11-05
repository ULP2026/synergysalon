/**
 * Stripe, for payroll (asked for 2026-11-05): a stylist's cash out is a
 * Stripe Connect transfer from the salon's Stripe balance to the stylist's
 * own Express account, and Stripe pays that account out to their bank.
 *
 * Plain HTTPS against Stripe's REST API rather than the SDK: four calls do
 * not justify another dependency in every function's bundle. The secret key
 * is `STRIPE_SECRET_KEY` in Vercel and never leaves the server; nothing here
 * returns it or logs it. Without it, `stripeReady()` is false and the
 * console says payouts are not switched on, instead of failing at the end.
 *
 * Tests swap the network for a stand-in with `setStripeTransport`, so they
 * check the guarantees (idempotency, verification, refusals) without
 * touching Stripe.
 */
const API = 'https://api.stripe.com/v1';

let transport = null;

/** For tests: replace the network with `fn(method, path, params, headers)`. */
export function setStripeTransport(fn) { transport = fn; }

export function stripeReady() {
  return Boolean(transport || process.env.STRIPE_SECRET_KEY);
}

/** Stripe's form encoding, nested keys included (capabilities[transfers][requested]). */
function encode(params, prefix = '', out = []) {
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') encode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join('&');
}

/** A Stripe error, with Stripe's own message for the person and its code for the log. */
export class StripeError extends Error {
  constructor(message, { status = 0, code = null, type = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

async function call(method, path, params = null, { idempotencyKey = null } = {}) {
  const headers = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (transport) return transport(method, path, params, headers);
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new StripeError('Payouts are not switched on yet.', { code: 'not_configured' });
  const body = params && method !== 'GET' ? encode(params) : null;
  const url = params && method === 'GET' ? `${API}${path}?${encode(params)}` : `${API}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2024-06-20',
      ...headers,
    },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error || {};
    throw new StripeError(e.message || `Stripe answered ${res.status}.`, { status: res.status, code: e.code || null, type: e.type || null });
  }
  return data;
}

/** A new Express account for a stylist, able to receive transfers. */
export function createAccount({ email, name, staffUserId, tenantId }) {
  const [first, ...rest] = String(name || '').trim().split(/\s+/);
  return call('POST', '/accounts', {
    type: 'express',
    country: 'US',
    email: email || undefined,
    business_type: 'individual',
    individual: first ? { first_name: first, last_name: rest.join(' ') || undefined, email: email || undefined } : undefined,
    capabilities: { transfers: { requested: true } },
    metadata: { staff_user_id: staffUserId, tenant_id: tenantId },
  }, { idempotencyKey: `acct-${staffUserId}` });
}

export function getAccount(id) {
  return call('GET', `/accounts/${encodeURIComponent(id)}`);
}

/** Stripe's own onboarding page for the account (bank, identity), one use, minutes long. */
export function accountLink(id, { refreshUrl, returnUrl }) {
  return call('POST', '/account_links', {
    account: id, refresh_url: refreshUrl, return_url: returnUrl, type: 'account_onboarding',
  });
}

/** A one-time link into the stylist's Express dashboard (payout history, bank). */
export function loginLink(id) {
  return call('POST', `/accounts/${encodeURIComponent(id)}/login_links`, {});
}

/**
 * Money from the salon's balance to the stylist's account. The key is the
 * cash out's own id: sent twice (a retry, a timeout), Stripe returns the
 * same transfer instead of paying twice.
 */
export function createTransfer({ amountCents, destination, idempotencyKey, group, description, metadata }) {
  return call('POST', '/transfers', {
    amount: amountCents, currency: 'usd', destination, transfer_group: group, description, metadata,
  }, { idempotencyKey });
}

/**
 * The transfer made for a cash out, found by its group, or null. Used to
 * settle one whose answer was lost: looking it up can never pay, where
 * sending it again could once Stripe's idempotency key has expired (24h).
 */
export async function findTransfer(group) {
  const list = await call('GET', '/transfers', { transfer_group: group, limit: 3 });
  return (list?.data || [])[0] || null;
}

export function getTransfer(id) {
  return call('GET', `/transfers/${encodeURIComponent(id)}`);
}

/** What the console needs to know about an account, and nothing about the person's bank. */
export function accountState(acct) {
  if (!acct) return { connected: false, ready: false, needsInfo: false };
  const transfers = acct.capabilities?.transfers;
  const ready = Boolean(acct.payouts_enabled && transfers === 'active');
  const bank = (acct.external_accounts?.data || [])[0];
  return {
    connected: Boolean(acct.details_submitted),
    ready,
    needsInfo: !ready,
    // "Chase ••••6789": enough to know where the money goes, nothing more.
    bank: bank ? `${bank.bank_name || (bank.object === 'card' ? bank.brand : 'Bank')} ••••${bank.last4}` : null,
  };
}
