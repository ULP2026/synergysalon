/**
 * The CENTRO client can only ask, never tell.
 *
 * Pushes to CENTRO were switched off on 21 October 2026 at the salon's
 * request, and the functions that wrote were removed rather than disabled.
 * This is the tripwire for one coming back: a new export that sends
 * something should be a decision somebody makes on purpose, with this test
 * changed alongside it, not a convenience that slips in.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as ghl from '../api/_lib/ghl.js';

test('the CENTRO client exports nothing that writes', () => {
  const writes = [
    'upsertContact', 'updateContact', 'deleteContact',
    'createAppointment', 'updateAppointment', 'setAppointmentStatus',
    'cancelAppointment', 'deleteAppointment',
  ];
  for (const name of writes) assert.equal(ghl[name], undefined, `${name} is back`);
  assert.deepEqual(
    Object.keys(ghl).sort(),
    ['GhlError', 'checkConnection', 'freeSlots', 'getCalendar', 'getUserName', 'parseFreeSlots', 'slotMinutes'],
  );
});

test('every request it makes is a GET', async () => {
  const src = await readFile(new URL('../api/_lib/ghl.js', import.meta.url), 'utf8');
  const methods = [...src.matchAll(/call\(tenant,\s*'([A-Z]+)'/g)].map((m) => m[1]);
  assert.ok(methods.length > 0, 'found the calls');
  assert.deepEqual([...new Set(methods)], ['GET']);
});

test('nothing in the app queues a job for CENTRO', async () => {
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const root = new URL('../api/', import.meta.url);
  const files = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  await walk(fileURLToPath(root));
  for (const f of files) {
    const src = await readFile(f, 'utf8');
    assert.ok(!/INSERT INTO sync_outbox/i.test(src), `${f} writes to sync_outbox`);
    assert.ok(!/\benqueueSync\b/.test(src), `${f} calls enqueueSync`);
  }
});
