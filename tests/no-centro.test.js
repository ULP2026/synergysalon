/**
 * Synergy has no connection to CENTRO (GoHighLevel). This is the tripwire.
 *
 * Luis's decision, 21 October 2026: nothing is sent to CENTRO and nothing is
 * read from it. The link was deleted rather than switched off, so there is no
 * flag for somebody to flip back by accident. These fail if any of it
 * returns: a new call to GoHighLevel should be a decision somebody makes on
 * purpose, with this file changed alongside it, not a convenience that slips
 * in.
 *
 * No database: it reads the source.
 */
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

async function jsFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await jsFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('nothing in the app talks to GoHighLevel', async () => {
  for (const f of [...await jsFiles(join(root, 'api')), ...await jsFiles(join(root, 'db'))]) {
    const src = await readFile(f, 'utf8');
    assert.ok(!/leadconnectorhq|msgsndr|gohighlevel/i.test(src), `${f} reaches GoHighLevel`);
    assert.ok(!/\bghl_(token|location_id|calendar_id|user_id)\b/.test(src), `${f} reads a ghl_* column`);
  }
});

test('nothing in the app queues a job for CENTRO', async () => {
  for (const f of await jsFiles(join(root, 'api'))) {
    const src = await readFile(f, 'utf8');
    assert.ok(!/INSERT\s+INTO\s+sync_outbox/i.test(src), `${f} writes to sync_outbox`);
    assert.ok(!/\benqueueSync\b/.test(src), `${f} calls enqueueSync`);
  }
});

test('the CENTRO client, route and scripts are gone', async () => {
  for (const f of ['api/_lib/ghl.js', 'api/_lib/centro-hours.js', 'api/staff/_routes/centro.js',
    'db/link-ghl.js', 'db/backfill-contacts.js']) {
    await assert.rejects(stat(join(root, f)), { code: 'ENOENT' }, `${f} is back`);
  }
  const { scripts } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(scripts['ghl:link'], undefined);
  assert.equal(scripts['db:backfill-contacts'], undefined);
});
