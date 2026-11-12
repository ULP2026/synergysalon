/**
 * Karen cancels and deletes herself (2026-11-12), read from staff/index.html.
 * The flows were walked in headless Chrome against a mocked API when built;
 * this keeps the promises: she asks Yes/No first, she calls the same
 * endpoints the screens do, and deleting is offered only to those the server
 * lets delete.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../staff/index.html', import.meta.url), 'utf8');
const body = (name) => {
  const at = html.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(at >= 0, `${name} is in the page`);
  const rest = html.slice(at);
  return rest.slice(0, rest.search(/\r?\n\}\r?\n/) + 3);
};

test('Karen asks "Delete this ticket?" with Yes and No before deleting', () => {
  assert.match(html, /ticket: \{ ask: 'Delete this ticket\?'/);
  assert.match(html, /cancel: \{ ask: 'Cancel this appointment\?'/);
  const confirm = body('kJobConfirm');
  assert.match(confirm, /label: 'Yes'/);
  assert.match(confirm, /label: 'No', run: kJobStop/);
  // the action runs only from the confirmation
  assert.match(body('kJobTicket'), /kJobConfirm\(\(\) => kJobDoTicket\(tk\)\)/);
  assert.match(body('kJobConfirmClient'), /kJobConfirm\(\(\) => kJobDoClient\(c\)\)/);
});

test('Karen does the work through the same endpoints as the screens', () => {
  const ticket = body('kJobDoTicket');
  assert.match(ticket, /\/api\/staff\/appointment/);
  assert.match(ticket, /action = job === 'cancel' \? 'cancel' : 'delete'/);
  assert.match(body('kJobDoClient'), /\/api\/staff\/contacts', \{ method: 'DELETE'/);
});

test('deleting is offered only to owners, admins and managers', () => {
  assert.match(html, /const kCanDelete = \(\) => Boolean\(me\?\.user\?\.canAdmin\)/);
  assert.match(body('kJob'), /job !== 'cancel' && !kCanDelete\(\)/);
  assert.match(body('kMenu'), /kCanDelete\(\) \? \[/);
});

test('"cancel <someone>\'s appointment" is a request, not "stop this booking"', () => {
  const submit = html.slice(html.indexOf("$('karenForm').onsubmit"));
  assert.ok(submit.indexOf('kJobFrom(t, raw)') < submit.indexOf('kControl(t, ask)'));
});
