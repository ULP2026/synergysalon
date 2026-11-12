/**
 * A bounced email turns Failed (asked for 2026-11-02, built 2026-11-12):
 * the app keeps Resend's id on the logged row, and Resend's email.bounced
 * webhook marks it, but only once Resend itself says it bounced. Resend is
 * a stand-in both ways (sending and looking up). The email is a real row,
 * written by the real sendStaffEmail outside any transaction, so it is
 * deleted at the end. Test people are named ZZ.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ensureSchema } from '../api/_lib/ensure-schema.js';
import { query } from '../api/_lib/db.js';
import { sendStaffEmail } from '../api/_lib/email.js';
import { bounceReason, handleBounce } from '../api/_lib/email-bounce.js';
import { tenantForUser } from '../api/_lib/tenant.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';

const resendSays = (last) => async (href, opts) => {
  assert.match(href, /^https:\/\/api\.resend\.com\/emails\/zz000000-/);
  assert.match(opts.headers.Authorization, /^Bearer /);
  return { ok: true, json: async () => ({ id: href.split('/').pop(), last_event: last }) };
};

test('the reason reads as the bounce, or plainly when Resend gave none', () => {
  assert.equal(bounceReason({ data: { bounce: { type: 'Permanent', message: 'The address does not exist.' } } }, 'bounced'),
    'Bounced (Permanent): The address does not exist.');
  assert.match(bounceReason({ data: {} }, 'bounced'), /did not accept it/);
  assert.match(bounceReason({ data: {} }, 'suppressed'), /held it back/);
});

test('a bounce marks the logged email Failed; a delivered one is left Sent', { skip }, async () => {
  await ensureSchema();
  const { rows: [t] } = await query("SELECT id FROM tenants WHERE slug = 'synergy'");
  const tenant = await tenantForUser({ tenant_id: t.id });
  const saved = globalThis.__synergyResend;
  const key = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY ||= 're_zz_test_key';
  const ids = ['zz000000-0000-4000-8000-00000000b001', 'zz000000-0000-4000-8000-00000000d002'];
  let n = 0;
  globalThis.__synergyResend = { emails: { send: async () => ({ data: { id: ids[n++] }, error: null }) } };
  try {
    for (const to of ['zz-bounce@example.com', 'zz-deliver@example.com']) {
      await sendStaffEmail({ to, toName: 'ZZ Bounce', subject: 'ZZ bounce test', text: 'Hello', fromName: 'ZZ' }, tenant);
    }
    const row = async (id) => (await query(
      'SELECT status, error FROM message_sends WHERE provider_id = $1', [id])).rows[0];
    assert.equal((await row(ids[0])).status, 'sent', 'Resend\'s id is kept on the row');

    // A forged or early call for a delivered email changes nothing.
    const kept = await handleBounce({ type: 'email.bounced', data: { email_id: ids[1] } }, { fetchFn: resendSays('delivered') });
    assert.match(kept.ignored, /delivered/);
    assert.equal((await row(ids[1])).status, 'sent');

    const out = await handleBounce(
      { type: 'email.bounced', data: { email_id: ids[0], bounce: { type: 'Permanent', message: 'No such user.' } } },
      { fetchFn: resendSays('bounced') },
    );
    assert.equal(out.marked, 1);
    assert.deepEqual(await row(ids[0]), { status: 'failed', error: 'Bounced (Permanent): No such user.' });

    // Resend retries webhooks: a second one is harmless.
    const again = await handleBounce({ type: 'email.bounced', data: { email_id: ids[0] } }, { fetchFn: resendSays('bounced') });
    assert.equal(again.marked, 0);

  } finally {
    globalThis.__synergyResend = saved;
    if (key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = key;
    await query("DELETE FROM message_sends WHERE provider_id LIKE 'zz000000-%' OR subject = 'ZZ bounce test'");
  }
});
