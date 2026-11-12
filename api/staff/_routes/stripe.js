/**
 * /api/staff/stripe: the salon's own Stripe account, linked with "Connect
 * with Stripe" on Settings, Money (Synergy App 1.0, asked for 2026-11-13,
 * "connect like Centro does"). The owner presses the button, signs in to
 * the salon's existing Stripe account on Stripe's own page (or makes one),
 * approves, and comes back here. Nobody pastes a key.
 *
 * The app's own Stripe account is the Connect platform (STRIPE_SECRET_KEY,
 * STRIPE_CLIENT_ID); the salon's account is linked to it and only its id is
 * kept (tenants.stripe_account_id, 061). Saved cards and no-show fees come
 * next and will be made on that account with the Stripe-Account header, so
 * the money is the salon's and the salon's Stripe handles refunds.
 *
 *   GET                    the status, for Settings (owner and admins)
 *   GET ?start=1           off to Stripe's sign-in
 *   GET ?code=&state=      Stripe sends them back here (the redirect URI
 *                          listed in the platform's Connect settings)
 *   POST {action:'disconnect'}
 *
 * Only the owner and admins (canManageTeam) link or unlink: the account is
 * where the salon's money goes. The state is signed and names the person
 * who started, and the person who comes back must be signed in as them, so
 * nobody can send the owner back with a different account attached.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { assertSameOrigin, canManageTeam, currentUser, requireTeamAdmin } from '../../_lib/auth.js';
import { ensureSchema } from '../../_lib/ensure-schema.js';
import { query } from '../../_lib/db.js';
import { HttpError, handler, json, readJson } from '../../_lib/http.js';
import {
  StripeError, connectReady, connectUrl, deauthorizeAccount, exchangeConnectCode, getAccount, salonAccountState,
} from '../../_lib/stripe.js';

const STATE_MINUTES = 15;

function secret() {
  return process.env.SESSION_SECRET || process.env.TOKEN_KEY || '';
}

function sign(value) {
  return createHmac('sha256', secret()).update(value).digest('base64url');
}

export function makeState(user, now = Date.now()) {
  const body = `${user.id}.${user.tenant_id}.${now}`;
  return `${body}.${sign(body)}`;
}

/** The person and salon the state names, or null when it is forged or old. */
export function readState(state, now = Date.now()) {
  const parts = String(state || '').split('.');
  if (parts.length !== 4 || !secret()) return null;
  const [userId, tenantId, at, mac] = parts;
  const a = Buffer.from(mac);
  const b = Buffer.from(sign(`${userId}.${tenantId}.${at}`));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (!(now - Number(at) >= 0 && now - Number(at) <= STATE_MINUTES * 60_000)) return null;
  return { userId, tenantId };
}

function origin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
  return { url: `${local ? 'http' : 'https'}://${host}`, app: host.startsWith('app.') };
}

/** Where Stripe sends them back: this endpoint, on the address they started from. */
export function redirectUri(req) {
  return `${origin(req).url}/api/staff/stripe`;
}

/** Back to Settings, Money, with what happened for the console to say. */
function backTo(req, res, outcome, why = '') {
  const o = origin(req);
  const q = new URLSearchParams({ tab: 'money', 'salon-stripe': outcome });
  if (why) q.set('why', why.slice(0, 200));
  res.status(302);
  res.setHeader('Location', `${o.url}${o.app ? '' : '/staff'}/settings?${q}`);
  res.setHeader('Cache-Control', 'no-store');
  return res.end();
}

function said(err) {
  if (err instanceof StripeError) {
    if (err.code === 'invalid_grant') return 'That Stripe link was already used or ran out. Please press Connect with Stripe again.';
    return err.message;
  }
  return 'Stripe did not answer. Please try again in a minute.';
}

async function stored(tenantId) {
  await ensureSchema();
  const { rows } = await query(
    `SELECT to_jsonb(t) ->> 'stripe_account_id' AS acct,
            (to_jsonb(t) ->> 'stripe_livemode')::boolean AS livemode,
            to_jsonb(t) ->> 'stripe_connected_at' AS connected_at,
            u.name AS connected_by
       FROM tenants t
       LEFT JOIN staff_users u ON u.id::text = to_jsonb(t) ->> 'stripe_connected_by'
      WHERE t.id = $1::uuid`,
    [tenantId],
  );
  return rows[0] || {};
}

/** What Settings shows. Never a key, never a bank. */
export async function salonStripeStatus(tenantId) {
  const configured = connectReady();
  const s = await stored(tenantId);
  if (!s.acct) return { configured, connected: false };
  const out = {
    configured,
    connected: true,
    livemode: s.livemode,
    connectedAt: s.connected_at,
    connectedBy: s.connected_by || null,
  };
  if (!configured) return out;
  try {
    Object.assign(out, salonAccountState(await getAccount(s.acct)));
  } catch (err) {
    // Unlinked from Stripe's side, or the platform's key changed.
    out.problem = said(err);
  }
  return out;
}

async function start(req, res) {
  const user = await currentUser(req);
  if (!user) return backTo(req, res, 'error', 'Please sign in again, then press Connect with Stripe.');
  if (!canManageTeam(user)) return backTo(req, res, 'error', 'Only the salon owner can connect the salon\'s Stripe.');
  if (!connectReady()) return backTo(req, res, 'error', 'Stripe is not set up on this site yet.');
  if (!secret()) return backTo(req, res, 'error', 'This site cannot sign the connection yet.');
  res.status(302);
  res.setHeader('Location', connectUrl({ state: makeState(user), redirectUri: redirectUri(req), email: user.email }));
  res.setHeader('Cache-Control', 'no-store');
  return res.end();
}

async function finish(req, res, url) {
  const error = url.searchParams.get('error');
  if (error) {
    return backTo(req, res, 'cancelled', error === 'access_denied'
      ? 'You cancelled, so nothing was connected.'
      : (url.searchParams.get('error_description') || 'Stripe did not connect the account.'));
  }
  const user = await currentUser(req);
  const st = readState(url.searchParams.get('state'));
  if (!st) return backTo(req, res, 'error', 'That link has expired. Please press Connect with Stripe again.');
  if (!user || user.id !== st.userId || user.tenant_id !== st.tenantId || !canManageTeam(user)) {
    return backTo(req, res, 'error', 'Please sign in as the person who pressed Connect with Stripe, and try again.');
  }
  let linked;
  try {
    linked = await exchangeConnectCode(String(url.searchParams.get('code') || ''));
    // Read it back through the platform before keeping it: proves the link works.
    await getAccount(linked.account);
  } catch (err) {
    console.error('salon stripe connect failed', err.code || '', err.message);
    return backTo(req, res, 'error', said(err));
  }
  await ensureSchema();
  await query(
    `UPDATE tenants SET stripe_account_id = $2, stripe_livemode = $3,
            stripe_connected_at = now(), stripe_connected_by = $4::uuid
      WHERE id = $1::uuid`,
    [user.tenant_id, linked.account, linked.livemode, user.id],
  );
  return backTo(req, res, 'connected');
}

export default handler({
  async GET(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.searchParams.get('start')) return start(req, res);
    if (url.searchParams.has('code') || url.searchParams.has('error')) return finish(req, res, url);
    const user = await requireTeamAdmin(req);
    return json(res, 200, await salonStripeStatus(user.tenant_id));
  },

  async POST(req, res) {
    assertSameOrigin(req);
    const user = await requireTeamAdmin(req);
    const body = await readJson(req);
    if (body.action !== 'disconnect') throw new HttpError(400, 'Unknown Stripe action.');
    const s = await stored(user.tenant_id);
    if (s.acct && connectReady()) {
      try {
        await deauthorizeAccount(s.acct);
      } catch (err) {
        // Already unlinked on Stripe's side is the outcome wanted anyway.
        if (!(err instanceof StripeError) || !['invalid_client', 'invalid_request'].includes(err.code)) {
          throw new HttpError(502, said(err));
        }
      }
    }
    await query(
      `UPDATE tenants SET stripe_account_id = NULL, stripe_livemode = NULL,
              stripe_connected_at = NULL, stripe_connected_by = NULL
        WHERE id = $1::uuid`,
      [user.tenant_id],
    );
    return json(res, 200, await salonStripeStatus(user.tenant_id));
  },
});
