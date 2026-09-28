import assert from 'node:assert/strict';
import test from 'node:test';

import { GhlError, deleteContact } from '../api/_lib/ghl.js';

const tenant = { ghl_token: 'tok', ghl_location_id: 'loc' };

function stubFetch(status) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (href, init) => {
    calls.push({ href, method: init.method });
    return new Response(status === 204 ? null : '{}', { status });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('deleting a CENTRO contact calls DELETE on that contact', async () => {
  const stub = stubFetch(200);
  try {
    await deleteContact(tenant, 'abc123');
    assert.deepEqual(stub.calls, [{
      href: 'https://services.leadconnectorhq.com/contacts/abc123', method: 'DELETE',
    }]);
  } finally { stub.restore(); }
});

test('a contact already gone from CENTRO counts as deleted', async () => {
  const stub = stubFetch(404);
  try {
    await deleteContact(tenant, 'abc123');
  } finally { stub.restore(); }
});

test('any other CENTRO failure is raised so the job retries', async () => {
  const stub = stubFetch(500);
  try {
    await assert.rejects(deleteContact(tenant, 'abc123'), GhlError);
  } finally { stub.restore(); }
});
