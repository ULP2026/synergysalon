/**
 * Marketing's email history: every email the automations sent, newest first,
 * a page at a time (history() in api/staff/_routes/business.js).
 *
 *   TEST_DATABASE_URL=postgres://… npm test
 *
 * It reads through the shared pool, which only sees committed rows, so this
 * commits its own send-log rows. They belong to a ZZ salon made for the test
 * and go with it in the finally, so nothing of the salon's is read or left
 * behind -- and because the salon is its own, the counts are exact.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { history } from '../api/staff/_routes/business.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const isLocal = url?.includes('localhost') || url?.includes('127.0.0.1');

test('every email sent, newest first, paged without skipping or repeating', { skip }, async () => {
  const c = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await c.connect();
  let tenantId = null;
  try {
    const { rows: [t] } = await c.query(
      `INSERT INTO tenants (slug, name) VALUES ($1, 'ZZ History Salon') RETURNING id`,
      [`zz-history-${Date.now()}`],
    );
    tenantId = t.id;

    // 120 sends: 60 of them in one and the same instant, so a page boundary
    // is certain to fall inside a run of identical timestamps -- the case a
    // cursor on time alone gets wrong.
    await c.query(
      `INSERT INTO message_sends (tenant_id, kind, to_name, to_email, sent_at)
       SELECT $1, CASE WHEN g % 2 = 0 THEN 'reminder' ELSE 'confirmation' END,
              'ZZ Guest ' || g, 'zz-' || g || '@example.com',
              CASE WHEN g <= 60 THEN timestamptz '2026-10-01 10:00:00.123456+00'
                   ELSE timestamptz '2026-10-01 10:00:00+00' + make_interval(secs => g) END
         FROM generate_series(1, 120) g`,
      [tenantId],
    );

    const seen = [];
    let page = await history({ id: tenantId }, null);
    assert.equal(page.sends.length, 50, 'a page is 50');
    seen.push(...page.sends);
    while (page.next) {
      page = await history({ id: tenantId }, page.next);
      seen.push(...page.sends);
    }

    assert.equal(seen.length, 120, 'every email, once');
    assert.equal(new Set(seen.map((s) => s.email)).size, 120, 'none twice');
    const times = seen.map((s) => new Date(s.sentAt).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');
    assert.equal(seen[0].email, 'zz-120@example.com', 'the latest is at the top');
    assert.ok(seen.every((s) => ['reminder', 'confirmation'].includes(s.kind)));

    // Another salon's emails never appear, and a cursor that is not one is
    // read as "from the top" rather than as an error.
    const other = await history({ id: '00000000-0000-0000-0000-000000000000' }, null);
    assert.deepEqual(other, { sends: [], next: null });
    const junk = await history({ id: tenantId }, 'not-a-cursor');
    assert.equal(junk.sends[0].email, 'zz-120@example.com');
  } finally {
    if (tenantId) await c.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    await c.end();
  }
});
