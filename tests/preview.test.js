/**
 * The staff pass that lets the paused booking popup be tried on the public
 * site (api/_lib/preview.js, minted by POST /api/staff/preview).
 *
 * Moved from tests/centro-hours.test.js when the CENTRO link was removed: the
 * pass never had anything to do with CENTRO, it only lived beside it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { mintPreview, previewAllowed } from '../api/_lib/preview.js';

test('a staff test pass works for its salon, and only until it expires', () => {
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = saved || 'postgres://test-only';
  try {
    const now = Date.now();
    const pass = mintPreview('tenant-a', now);
    const req = (v) => ({ headers: { 'x-booking-preview': v } });
    assert.equal(previewAllowed(req(pass), { id: 'tenant-a' }, now), true);
    assert.equal(previewAllowed(req(pass), { id: 'tenant-b' }, now), false);
    assert.equal(previewAllowed(req(pass), { id: 'tenant-a' }, now + 13 * 3600 * 1000), false);
    assert.equal(previewAllowed(req(`${pass.split('.')[0]}.forged`), { id: 'tenant-a' }, now), false);
    assert.equal(previewAllowed({ headers: {} }, { id: 'tenant-a' }, now), false);
    // The project's own Vercel addresses (behind Vercel's login) are the test
    // link; the salon's domain never passes on its host alone.
    assert.equal(previewAllowed({ headers: { host: 'synergysalon-abc123-support-2531s-projects.vercel.app' } }, { id: 'tenant-a' }, now), true);
    assert.equal(previewAllowed({ headers: { host: 'synergysalon.com' } }, { id: 'tenant-a' }, now), false);
    assert.equal(previewAllowed({ headers: { host: 'synergysalon.com.evil.app' } }, { id: 'tenant-a' }, now), false);
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved;
  }
});
