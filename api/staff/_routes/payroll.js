/**
 * GET  /api/staff/payroll: the signed-in person's Payroll: their earned
 *      income still to be paid (the balance), every visit it was earned
 *      from (`earnings`), their Stripe account's state, and their cash outs.
 *      The owner also gets the team's cash outs.
 * POST /api/staff/payroll {action: 'connect'}: a Stripe onboarding link for
 *      their own Express account (made on the first connect).
 * POST /api/staff/payroll {action: 'dashboard'}: a link into it.
 * POST /api/staff/payroll {action: 'cashout', amount?}: pay out the whole
 *      balance, or `amount` dollars of it (Partial Cashout), by Stripe.
 *
 * Asked for 2026-11-05, replacing the request-and-mark-paid cash out of
 * 2026-11-04. What keeps it safe is all here, not in the console:
 *
 * - The money only ever goes to the account stored on the person's own
 *   login. Nothing the browser sends names an account.
 * - The amount is checked against the balance inside a transaction that
 *   locks the person's row, and the cash out is written as 'processing'
 *   before Stripe is called, so it already counts against the balance: two
 *   taps or two tabs cannot pay the same money twice.
 * - The transfer is sent with the cash out's id as Stripe's idempotency
 *   key, so a retry returns the same transfer rather than a second one.
 * - It is 'paid' only once the transfer has been read back from Stripe and
 *   matches (amount, currency, destination, not reversed). The console
 *   shows its confetti only on that answer. Anything else is 'failed' with
 *   Stripe's reason, and the money is back in the balance.
 *
 * The balance is the booked value of the person's kept visits that have
 * already happened (as Finance counts "earned": not cancelled, not a
 * no-show, the price booked else the service's; unpriced visits add
 * nothing), less every cash out that is paid, processing or still a manual
 * request. It is what the salon asked to show as "Earned Income".
 */
import { assertSameOrigin, requireStaff } from '../../_lib/auth.js';
import { query, transaction } from '../../_lib/db.js';
import { HttpError, handler, json, readJson } from '../../_lib/http.js';
import { chairOf, seesAll } from '../../_lib/scope.js';
import {
  StripeError, accountLink, accountState, createAccount, createTransfer, findTransfer, getAccount, getTransfer, loginLink,
  payoutsOn,
} from '../../_lib/stripe.js';
import { tenantForUser } from '../../_lib/tenant.js';

const MIN_CENTS = 100;            // $1: below that a bank transfer is not worth making
const MAX_CENTS = 5000000;        // $50,000 in one go; a typo guard, not a policy

/**
 * The visits that count as earned, as one clause for both the balance and
 * the list in the cash-out window (asked for 2026-11-05), so the list can
 * never add up to something other than the balance. $1 tenant, $2 the
 * chair's stylist ids.
 */
const EARNED_FROM = `FROM appointments a JOIN services v ON v.id = a.service_id
      WHERE a.tenant_id = $1::uuid AND a.stylist_id = ANY($2::uuid[])
        AND a.starts_at < now() AND a.status::text NOT IN ('cancelled', 'no_show')`;
const EARNED_CENTS = 'COALESCE(a.price_cents, v.price_cents)';
const EARNINGS_SHOWN = 1000;      // the newest; the totals always count every one

/** Earned, less what is paid out or on its way. `db` may be a transaction's client. */
export async function balanceOf(user, db = null) {
  const q = db ? db.query.bind(db) : query;
  const chair = await chairOf(user, db);
  const ids = chair ? chair.ids : [];
  const earned = ids.length ? (await q(
    `SELECT COALESCE(sum(${EARNED_CENTS}), 0)::bigint AS cents ${EARNED_FROM}`,
    [user.tenant_id, ids],
  )).rows[0].cents : 0;
  const { rows } = await q(
    `SELECT COALESCE(sum(amount_cents) FILTER (WHERE status = 'paid'), 0)::bigint AS paid,
            COALESCE(sum(amount_cents) FILTER (WHERE status IN ('processing', 'requested')), 0)::bigint AS pending
       FROM cashout_requests WHERE tenant_id = $1::uuid AND staff_user_id = $2::uuid`,
    [user.tenant_id, user.id],
  );
  const earnedCents = Number(earned);
  const paidCents = Number(rows[0].paid);
  const pendingCents = Number(rows[0].pending);
  return {
    hasChair: ids.length > 0,
    earnedCents,
    paidCents,
    pendingCents,
    availableCents: Math.max(0, earnedCents - paidCents - pendingCents),
  };
}

/**
 * Every visit behind the earned figure, newest first: when, what, for whom
 * and what it earned. A visit with no price is listed and earns nothing,
 * as the balance counts it; it is never given a guessed price.
 */
export async function earningsOf(user) {
  const chair = await chairOf(user);
  const ids = chair ? chair.ids : [];
  if (!ids.length) return { count: 0, unpriced: 0, totalCents: 0, rows: [] };
  const [{ rows: [t] }, { rows }] = await Promise.all([
    query(
      `SELECT count(*)::int AS count, count(*) FILTER (WHERE ${EARNED_CENTS} IS NULL)::int AS unpriced,
              COALESCE(sum(${EARNED_CENTS}), 0)::bigint AS cents ${EARNED_FROM}`,
      [user.tenant_id, ids],
    ),
    query(
      `SELECT a.id, a.ref, a.starts_at, a.guest_name, v.name AS service,
              to_jsonb(a) -> 'services' AS lines, ${EARNED_CENTS} AS cents
         ${EARNED_FROM}
        ORDER BY a.starts_at DESC, a.id
        LIMIT ${EARNINGS_SHOWN}`,
      [user.tenant_id, ids],
    ),
  ]);
  return {
    count: t.count,
    unpriced: t.unpriced,
    totalCents: Number(t.cents),
    rows: rows.map((r) => {
      // A visit of several services keeps each line as booked (031).
      const names = Array.isArray(r.lines) ? r.lines.map((x) => x && x.name).filter(Boolean) : [];
      return {
        id: r.id,
        ref: r.ref,
        at: r.starts_at,
        client: r.guest_name,
        service: names.length ? names.join(' + ') : r.service,
        cents: r.cents == null ? null : Number(r.cents),
      };
    }),
  };
}

async function storedAccount(user) {
  const { rows } = await query(
    "SELECT to_jsonb(s) ->> 'stripe_account_id' AS acct, email, name FROM staff_users s WHERE id = $1::uuid",
    [user.id],
  );
  return rows[0] || {};
}

async function stripeOf(acctId) {
  if (!payoutsOn()) return { configured: false, connected: false, ready: false };
  if (!acctId) return { configured: true, connected: false, ready: false };
  try {
    return { configured: true, ...accountState(await getAccount(acctId)) };
  } catch (err) {
    console.error('payroll: account read failed', err.code || err.status || err.message);
    return { configured: true, connected: false, ready: false, error: 'Stripe did not answer. Try again in a minute.' };
  }
}

async function history(user, everyone) {
  const { rows } = await query(
    `SELECT r.id, r.staff_name, r.amount_cents, r.note, r.status, r.created_at, r.decided_at,
            to_jsonb(r) ->> 'error' AS error, to_jsonb(r) ->> 'stripe_transfer_id' AS transfer,
            r.staff_user_id
       FROM cashout_requests r
      WHERE r.tenant_id = $1::uuid AND ($2::uuid IS NULL OR r.staff_user_id = $2::uuid)
      ORDER BY r.created_at DESC LIMIT 60`,
    [user.tenant_id, everyone ? null : user.id],
  ).catch((err) => { if (err.code === '42P01') return { rows: [] }; throw err; });
  return rows.map((r) => ({
    id: r.id,
    name: r.staff_name,
    mine: String(r.staff_user_id) === String(user.id),
    amountCents: r.amount_cents,
    status: r.status,
    via: r.transfer ? 'stripe' : 'manual',
    error: r.status === 'failed' ? (r.error || 'Stripe refused it.') : null,
    note: r.note || '',
    at: r.created_at,
    decidedAt: r.decided_at,
  }));
}

function appUrl(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
  const base = `${local ? 'http' : 'https'}://${host}${host.startsWith('app.') ? '' : '/staff'}`;
  return `${base}/settings?tab=money`;
}

/** Stripe's reason, said for a person. */
function said(err) {
  if (err instanceof StripeError) {
    if (err.code === 'balance_insufficient') {
      return 'The salon\'s Stripe balance is too low to pay this right now, so nothing was paid. Let the owner know, or try a smaller amount later.';
    }
    if (err.code === 'not_configured') return err.message;
    return `Stripe said: ${err.message}`;
  }
  return 'Stripe did not answer, so nothing was paid. Try again in a minute.';
}

async function cashOut(user, tenant, body) {
  if (!payoutsOn()) throw new HttpError(503, 'Payouts are not switched on for the salon yet.', 'NOT_CONFIGURED');
  const { acct } = await storedAccount(user);
  if (!acct) throw new HttpError(409, 'Connect your Stripe account first, so the money has somewhere to go.', 'NO_ACCOUNT');
  const state = await stripeOf(acct);
  if (!state.ready) {
    throw new HttpError(409, state.error || 'Stripe still needs a few details from you before it can pay you. Finish setting up your Stripe account.', 'NEEDS_INFO');
  }

  // Reserve the money first. The row lock on the person makes two cash outs
  // at once take turns, and the second sees the first's 'processing' row.
  const partial = body.amount !== undefined && body.amount !== null && body.amount !== '';
  const row = await transaction(async (db) => {
    await db.query('SELECT id FROM staff_users WHERE id = $1::uuid FOR UPDATE', [user.id]);
    const bal = await balanceOf(user, db);
    const cents = partial ? Math.round(Number(body.amount) * 100) : bal.availableCents;
    if (!Number.isFinite(cents) || cents <= 0) throw new HttpError(400, 'Type the amount in dollars, like 50 or 50.25.');
    if (cents < MIN_CENTS) throw new HttpError(400, bal.availableCents < MIN_CENTS ? 'There is nothing to cash out yet.' : 'The smallest cash out is $1.00.');
    if (cents > MAX_CENTS) throw new HttpError(400, 'That is more than one cash out can be. Try a smaller amount.');
    if (cents > bal.availableCents) {
      throw new HttpError(400, `That is more than your balance of $${(bal.availableCents / 100).toFixed(2)}.`, 'OVER_BALANCE');
    }
    const { rows } = await db.query(
      `INSERT INTO cashout_requests (tenant_id, staff_user_id, staff_name, amount_cents, note, status)
       VALUES ($1::uuid, $2::uuid, $3::text, $4::int, $5::text, 'processing') RETURNING id`,
      [tenant.id, user.id, user.name || user.email, cents, partial ? 'Partial cashout' : 'Cash out'],
    );
    return { id: rows[0].id, cents };
  });

  const fail = async (message) => {
    await query(
      "UPDATE cashout_requests SET status = 'failed', error = $2::text, decided_at = now() WHERE id = $1::uuid",
      [row.id, message.slice(0, 500)],
    );
  };
  let transfer;
  try {
    const sent = await createTransfer({
      amountCents: row.cents,
      destination: acct,
      idempotencyKey: `cashout-${row.id}`,
      group: `cashout-${row.id}`,
      description: `${tenant.name || 'Salon'} payroll: ${user.name || user.email}`,
      metadata: { cashout_id: row.id, staff_user_id: user.id, tenant_id: tenant.id },
    });
    // Read back from Stripe, not trusted from the create's reply alone.
    transfer = sent?.id ? await getTransfer(sent.id) : null;
  } catch (err) {
    console.error('payroll: transfer failed', err.code || err.status || err.message);
    // A timeout leaves it unknown whether Stripe made the transfer; the
    // idempotency key makes the next try safe, and until then the money
    // stays reserved rather than paid twice.
    if (!(err instanceof StripeError)) {
      throw new HttpError(502, 'Stripe did not answer in time. Your balance is held while we check; try again in a minute and it will not pay twice.', 'STRIPE_UNKNOWN');
    }
    const message = said(err);
    await fail(message);
    throw new HttpError(402, message, 'STRIPE_REFUSED');
  }
  const ok = transfer && transfer.id && transfer.amount === row.cents && transfer.currency === 'usd'
    && transfer.destination === acct && !transfer.reversed;
  if (!ok) {
    await fail('Stripe\'s record of the transfer did not match the cash out.');
    throw new HttpError(502, 'Stripe\'s record of the transfer did not match, so it was not marked paid. The salon has been asked to check.', 'STRIPE_MISMATCH');
  }
  await query(
    `UPDATE cashout_requests SET status = 'paid', stripe_transfer_id = $2::text, decided_at = now(), error = NULL
      WHERE id = $1::uuid`,
    [row.id, transfer.id],
  );
  return {
    ok: true,
    verified: true,
    id: row.id,
    amountCents: row.cents,
    transferId: transfer.id,
    balance: await balanceOf(user),
  };
}

/**
 * A cash out left 'processing' because Stripe's answer was lost (a
 * timeout): look its transfer up by group, never send it again. Found and
 * matching, it is paid; not there after ten minutes, it never happened, and
 * the money goes back to the balance. Run when Payroll opens.
 */
async function settleStuck(user) {
  if (!payoutsOn()) return;
  const { rows } = await query(
    `SELECT r.id, r.amount_cents, r.created_at < now() - interval '10 minutes' AS old,
            to_jsonb(s) ->> 'stripe_account_id' AS acct
       FROM cashout_requests r JOIN staff_users s ON s.id = r.staff_user_id
      WHERE r.staff_user_id = $1::uuid AND r.status = 'processing' AND r.created_at < now() - interval '2 minutes'`,
    [user.id],
  ).catch(() => ({ rows: [] }));
  for (const r of rows) {
    try {
      const t = await findTransfer(`cashout-${r.id}`);
      if (t && t.amount === r.amount_cents && t.destination === r.acct && !t.reversed) {
        await query("UPDATE cashout_requests SET status = 'paid', stripe_transfer_id = $2::text, decided_at = now() WHERE id = $1::uuid", [r.id, t.id]);
      } else if (!t && r.old) {
        await query("UPDATE cashout_requests SET status = 'failed', error = $2::text, decided_at = now() WHERE id = $1::uuid",
          [r.id, 'Stripe never made this transfer, so nothing was paid. The amount is back in your balance.']);
      }
    } catch (err) {
      console.error('payroll: settling a held cash out failed', err.code || err.message);
    }
  }
}

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req);
    await settleStuck(user);
    const { acct } = await storedAccount(user);
    const [balance, stripe, mine, earnings] = await Promise.all([
      balanceOf(user), stripeOf(acct), history(user, false), earningsOf(user),
    ]);
    const owner = seesAll(user);
    return json(res, 200, {
      balance,
      // What the earned income is made of, for the cash-out window.
      earnings,
      stripe,
      history: mine,
      // The owner sees the team's payouts too, and settles the manual
      // requests left from before Stripe.
      team: owner ? await history(user, true) : null,
      canDecide: owner,
    });
  },

  async POST(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);
    const body = await readJson(req);
    const action = String(body.action || '');

    if (action === 'connect') {
      if (!payoutsOn()) throw new HttpError(503, 'Payouts are not switched on for the salon yet.', 'NOT_CONFIGURED');
      let { acct, email, name } = await storedAccount(user);
      if (!acct) {
        const made = await createAccount({ email, name, staffUserId: user.id, tenantId: tenant.id })
          .catch((err) => { throw new HttpError(502, said(err)); });
        acct = made.id;
        // Only if none was stored meanwhile: a second tab must not orphan the first's account.
        await query(
          "UPDATE staff_users SET stripe_account_id = $2::text WHERE id = $1::uuid AND stripe_account_id IS NULL",
          [user.id, acct],
        );
        acct = (await storedAccount(user)).acct;
      }
      const back = appUrl(req);
      const link = await accountLink(acct, {
        refreshUrl: `${back}&stripe=refresh`, returnUrl: `${back}&stripe=return`,
      }).catch((err) => { throw new HttpError(502, said(err)); });
      return json(res, 200, { url: link.url });
    }

    if (action === 'dashboard') {
      const { acct } = await storedAccount(user);
      if (!acct || !payoutsOn()) throw new HttpError(409, 'Connect your Stripe account first.');
      const link = await loginLink(acct).catch((err) => { throw new HttpError(502, said(err)); });
      return json(res, 200, { url: link.url });
    }

    if (action === 'cashout') return json(res, 200, await cashOut(user, tenant, body));

    throw new HttpError(400, 'Unknown payroll action.');
  },
});
