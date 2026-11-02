/**
 * Sent History under an automation (2026-11-02): who it reached by email and
 * by text, newest first, only its own kinds, failures marked.
 *
 * Skips without DATABASE_URL. Runs in a throwaway ZZ tenant and removes it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { pool } from '../api/_lib/db.js';
import { automationSends } from '../api/staff/_routes/business.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
const cleanup = () => pool().query("DELETE FROM tenants WHERE slug = 'zz-sends'");

test("an automation's emails and texts, newest first, and nobody else's", { skip }, async () => {
  await cleanup();
  const db = pool();
  try {
    const t = (await db.query("INSERT INTO tenants (slug, name, timezone) VALUES ('zz-sends', 'ZZ Sends', 'America/New_York') RETURNING id")).rows[0];
    const c = (await db.query("INSERT INTO contacts (tenant_id, name, email, phone) VALUES ($1, 'ZZ Rosa', 'zz-rosa@example.com', '8135550170') RETURNING id", [t.id])).rows[0];
    const email = (kind, mins, status = 'sent') => db.query(
      `INSERT INTO message_sends (tenant_id, kind, to_name, to_email, sent_at, status, contact_id)
       VALUES ($1, $2, 'ZZ Rosa', 'zz-rosa@example.com', now() - ($3 || ' minutes')::interval, $4, $5)`,
      [t.id, kind, String(mins), status, c.id],
    );
    await email('confirmation', 30);
    await email('reminder', 20);                       // another automation's
    await email('confirmation', 5, 'failed');
    await db.query(
      `INSERT INTO client_texts (tenant_id, contact_id, direction, kind, phone, body, created_at)
       VALUES ($1, $2, 'out', 'confirmation', '8135550170', 'ZZ text', now() - interval '10 minutes'),
              ($1, $2, 'in', 'confirmation', '8135550170', 'ZZ reply', now() - interval '9 minutes')`,
      [t.id, c.id],
    );
    const { sends, next } = await automationSends(t, 'confirmation', null);
    assert.deepEqual(sends.map((x) => [x.channel, x.status]), [['email', 'failed'], ['sms', 'sent'], ['email', 'sent']]);
    assert.equal(sends[1].name, 'ZZ Rosa');
    assert.equal(sends[1].to, '(813) 555-0170');
    assert.equal(sends[1].contactId, c.id);
    assert.equal(next, null);
    await assert.rejects(automationSends(t, 'not-a-kind', null), /No such automation/);
  } finally {
    await cleanup();
  }
});
