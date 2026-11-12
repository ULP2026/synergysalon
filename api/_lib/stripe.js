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
// Stripe Connect's sign-in ("Connect with Stripe", as Centro does it): the
// salon's own, existing Stripe account is linked to the app's platform
// account (2026-11-13). It answers on its own host, not the API's.
const CONNECT = 'https://connect.stripe.com';

let transport = null;

/** For tests: replace the network with `fn(method, path, params, headers)`. */
export function setStripeTransport(fn) { transport = fn; }

export function stripeReady() {
  return Boolean(transport || process.env.STRIPE_SECRET_KEY);
}

/**
 * Payroll's payouts, kept off until Synergy App 2.0 (Luis, 2026-11-13).
 * STRIPE_SECRET_KEY is now the app's own platform key, there so salons can
 * connect their Stripe; without this switch, setting it would have turned
 * Cash Out on and paid stylists out of the platform's balance. It takes
 * STRIPE_PAYOUTS=on as well. Tests drive payroll through a stand-in.
 */
export function payoutsOn() {
  return Boolean(transport) || (Boolean(process.env.STRIPE_SECRET_KEY) && process.env.STRIPE_PAYOUTS === 'on');
}

/** "Connect with Stripe" needs the platform's key and its Connect client id (ca_...). */
export function connectReady() {
  return Boolean(transport) || Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_CLIENT_ID);
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

/**
 * One request. `connect` sends it to Stripe Connect's host (the stand-in
 * sees the path as `connect:/oauth/token`); `account` makes it on a
 * connected account's behalf (the Stripe-Account header), which is how the
 * salon's own cards and charges will live in the salon's own Stripe.
 */
async function call(method, path, params = null, { idempotencyKey = null, connect = false, account = null } = {}) {
  const headers = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (account) headers['Stripe-Account'] = account;
  if (transport) return transport(method, connect ? `connect:${path}` : path, params, headers);
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new StripeError('Stripe is not set up on this site yet.', { code: 'not_configured' });
  const base = connect ? CONNECT : API;
  const body = params && method !== 'GET' ? encode(params) : null;
  const url = params && method === 'GET' ? `${base}${path}?${encode(params)}` : `${base}${path}`;
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
    // Connect's sign-in answers errors as { error: 'invalid_grant', error_description }.
    if (typeof data.error === 'string') {
      throw new StripeError(data.error_description || `Stripe answered ${res.status}.`, { status: res.status, code: data.error });
    }
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

// ── The salon's own Stripe, linked by "Connect with Stripe" ──────────────

/**
 * Stripe's own sign-in page, where the owner signs in to the salon's
 * existing Stripe account (or makes one) and approves the link. `state` is
 * signed by the caller and comes back unchanged; `redirectUri` must be one
 * listed in the platform's Connect settings, or Stripe refuses it.
 */
export function connectUrl({ state, redirectUri, email }) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.STRIPE_CLIENT_ID || 'ca_test',
    scope: 'read_write',
    state,
    redirect_uri: redirectUri,
  });
  if (email) q.set('stripe_user[email]', email);
  return `${CONNECT}/oauth/authorize?${q}`;
}

/**
 * The code Stripe sent back, swapped for the linked account's id. Stripe
 * also returns keys for that account; they are not kept: the platform's own
 * key with the account's id (Stripe-Account) does everything the app needs.
 */
export async function exchangeConnectCode(code) {
  const t = await call('POST', '/oauth/token', { grant_type: 'authorization_code', code }, { connect: true });
  if (!t?.stripe_user_id) throw new StripeError('Stripe did not say which account was connected.', { code: 'no_account' });
  return { account: t.stripe_user_id, livemode: Boolean(t.livemode) };
}

/** Unlinks the salon's account from the platform (Disconnect). */
export function deauthorizeAccount(account) {
  return call('POST', '/oauth/deauthorize', {
    client_id: process.env.STRIPE_CLIENT_ID || 'ca_test', stripe_user_id: account,
  }, { connect: true });
}

/** What Settings shows about the salon's account: its name, and whether it can take payments. */
export function salonAccountState(acct) {
  if (!acct) return null;
  const bp = acct.business_profile || {};
  return {
    name: acct.settings?.dashboard?.display_name || bp.name || acct.email || null,
    email: acct.email || null,
    chargesEnabled: Boolean(acct.charges_enabled),
    detailsSubmitted: Boolean(acct.details_submitted),
  };
}
