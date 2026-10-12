import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_LAYOUT, layoutFrom, layoutOf } from '../api/_lib/home-layout.js';

test('a layout keeps known widgets once, with views they support', () => {
  const out = layoutFrom([
    { id: 'visits', view: 'line', size: 'full' },
    { id: 'visits', view: 'bar', size: 'half' },     // a second copy is dropped
    { id: 'nope', view: 'bar' },                      // unknown widget
    { id: 'today', view: 'line', size: 'huge' },      // a view it has not got
  ]);
  assert.deepEqual(out, [
    { id: 'visits', view: 'line', size: 'full' },
    { id: 'today', view: 'number', size: 'half' },
  ]);
});

test('an empty layout is allowed: the admin removed everything', () => {
  assert.deepEqual(layoutFrom([]), []);
});

test('nothing stored, or something unreadable, is the default', () => {
  assert.equal(layoutOf(null), DEFAULT_LAYOUT);
  assert.equal(layoutOf('not json'), DEFAULT_LAYOUT);
  assert.deepEqual(layoutOf([{ id: 'weekdays', view: 'table', size: 'half' }]),
    [{ id: 'weekdays', view: 'table', size: 'half' }]);
});

test('a layout that is not a list is refused', () => {
  assert.throws(() => layoutFrom({ id: 'today' }), /could not be read/);
});
