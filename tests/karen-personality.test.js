/**
 * Karen has one personality, the salon's own words, in both places she
 * talks: by text (karen-ai.js) and in the app (karen-desk.js).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { KAREN_PERSONALITY } from '../api/_lib/karen-ai.js';

test('both Karens use the one shared personality', () => {
  assert.match(KAREN_PERSONALITY, /Phoebe Buffay/);
  assert.match(KAREN_PERSONALITY, /Being useful always beats being funny/);
  assert.match(KAREN_PERSONALITY, /Never make up facts, prices, or promises/);
  assert.doesNotMatch(KAREN_PERSONALITY, /\u2014/, 'no em dashes in the instructions that forbid them');
  for (const f of ['../api/_lib/karen-ai.js', '../api/_lib/karen-desk.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    const prompt = src.slice(src.indexOf('const STATIC = `'), src.indexOf('`;', src.indexOf('const STATIC = `')));
    assert.match(prompt, /\$\{KAREN_PERSONALITY\}/, `${f} uses the shared personality`);
  }
});
