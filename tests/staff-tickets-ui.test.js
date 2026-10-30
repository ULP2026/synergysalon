/**
 * The staff app's side of tickets and clients, read from staff/index.html:
 * the promises the page makes that no server test can see.
 *
 * Not a browser test. The behaviour was checked in headless Chrome when it
 * was built; this keeps the contracts from quietly coming undone in a later
 * edit of an 9,000-line file.
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

test('client search in New appointment waits for the third letter', () => {
  assert.match(body('searchBookClients'), /q\.length < 3/);
  // and searches the same contacts endpoint Clients does, a few at a time
  assert.match(body('searchBookClients'), /\/api\/staff\/contacts\?/);
});

test('picking a client fills in their details and links the booking to them', () => {
  const pick = body('pickBookClient');
  assert.match(pick, /bookPhone/);
  assert.match(pick, /bookEmail/);
  assert.match(html, /contact: bookContact\?\.id \|\| null/);
});

test('several services go to the server as one booking', () => {
  // the first is the service, the rest go with it
  assert.match(html, /service: bookLines\[0\]\.slug/);
  assert.match(html, /with: bookLines\.slice\(1\)\.map/);
});

test('the Appt. Book and a client\'s history open the same ticket', () => {
  assert.match(body('openAppt'), /openTicket\(a\.ref, a\)/);
  assert.match(body('openTicket'), /\/api\/staff\/appointment\?ref=/);
  // the profile's appointment rows and its timeline both carry the ref
  assert.match(body('renderPerson'), /data-ticket="\$\{esc\(a\.ref\)\}"/);
  assert.match(body('renderTimeline'), /data-ticket="\$\{esc\(e\.ref\)\}"/);
});

test('check-in, no-show and cancel stay on the ticket', () => {
  const paint = body('paintTicket');
  for (const act of ['check_in', 'no_show', 'cancel', 'complete', 'reopen']) {
    assert.match(paint, new RegExp(`b\\('${act}'`), act);
  }
});

test('a client wears their stylist, not where the record came from', () => {
  const list = body('renderContacts');
  assert.doesNotMatch(list, /data-source=/);
  // In the list the stylist is the Book button's face (the name tag left the
  // row on request, 2026-10-30). On the profile it is a headshot on their
  // circle and a Stylist row in Contact details, not a tag (2026-10-31).
  assert.match(list, /bookButton\(c\)/);
  assert.match(body('bookButton'), /c\.stylist/);
  assert.doesNotMatch(body('personChips'), /stylist/);
  assert.match(body('renderPerson'), /paintPxStylist\(c\)/);
  assert.match(body('renderPerson'), /<dt>Stylist<\/dt>/);
});

test('Choose your stylist is built from every stylist record the server lists', () => {
  assert.match(body('fillStylistFilter'), /Choose your stylist/);
  assert.match(html, /contacts\?q=\$\{encodeURIComponent\(qv\)\}&stylist=\$\{encodeURIComponent\(sv\)\}&stylists=1/);
});

test('email and texts are two separate switches', () => {
  const p = body('renderPerson');
  assert.match(p, /sw\('email'/);
  assert.match(p, /sw\('sms'/);
});
