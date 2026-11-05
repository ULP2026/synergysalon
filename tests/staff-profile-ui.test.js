/**
 * The console changes of 2026-11-03, read from staff/index.html: the
 * promises the page makes that no server test can see. Checked in headless
 * Chrome when they were built; this keeps them from quietly coming undone.
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

test('a move redraws Appt. Book in place, never back to a skeleton', () => {
  assert.match(body('refreshDiary'), /quiet = true/);
  assert.match(body('loadMonth'), /if \(!quiet\)/);
});

test('Finance is on Money, above Subscription, and not on Home', () => {
  const home = html.slice(html.indexOf('<section class="view" id="view-home">'), html.indexOf('<!-- Appointments -->'));
  assert.ok(!home.includes('id="homeFin"'));
  const money = html.slice(html.indexOf('id="set-payment"'));
  assert.ok(money.indexOf('id="homeFin"') < money.indexOf('id="subCard"'));
  assert.match(body('showSetting'), /name === 'payment'\) renderFinance\(\)/);
});

test('the Salon Profile has no About and no standing Save button', () => {
  const biz = body('renderBusiness');
  assert.ok(!/name="about"/.test(biz), 'no About field');
  assert.ok(!biz.includes('Save Salon Profile'));
  for (const label of ['Salon name', 'Phone', 'Website', 'Google review link', 'Address', 'Booking page', 'Time zone']) {
    assert.ok(biz.includes(`'${label}'`), `${label} is listed`);
  }
  // The save leaves About out, so the server keeps what is stored.
  assert.ok(!/about:/.test(biz));
});

test('the team window says Available Hours and Special Instructions When Booking Clients', () => {
  assert.ok(html.includes('<div class="md-sec wh-sec">Available Hours <span class="wh-total" id="whTotal" data-no-i18n></span></div>'));
  assert.ok(html.includes('Special Instructions When Booking Clients'));
  assert.ok(!html.includes('Notes / Special Instructions for Clients'));
});

test('a kind of service opens with its switch and folds when switched off', () => {
  assert.match(html, /svc \$\{v\.on \? 'open' : 'off'\}/);
  assert.match(html, /svcOpen\(row, on\);/);
});

test('Activity filters are Admin, not Automations or Forms; no reference numbers', () => {
  const types = html.slice(html.indexOf('const TL_TYPES'), html.indexOf('];', html.indexOf('const TL_TYPES')));
  assert.match(types, /\['admin', 'Admin'\]/);
  assert.ok(!/'form'|'automation'/.test(types));
  assert.ok(!body('renderTimeline').includes('Ref '));
  assert.match(body('renderTimeline'), /apptAt/);
});

test('messages start on Text, blue, with Email red', () => {
  assert.match(body('openPerson'), /pxDraft = \{ ch: 'sms'/);
  assert.match(html, /\.px-compose \{ --pc: #2f6fd6;/);
  assert.match(html, /\.px-compose\[data-ch="email"\] \{ --pc: #c8323f;/);
});

test('someone added keeps the picture the window showed them with', () => {
  // With no picture chosen, the default drawn from their name is saved with
  // them, so the Team list cannot draw a different one afterwards.
  assert.match(html, /if \(!memberEdit && memberPic === undefined\) fields\.avatar = charAvatar\(/);
  // and the window's default follows the name as it is typed
  assert.match(html, /elements\.name\.addEventListener\('input', \(\) => \{\n {2}if \(!memberEdit && memberPic === undefined\) memberPicPaint\(undefined\);/);
});
