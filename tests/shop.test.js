/**
 * The shop a guest is told about.
 *
 * This used to be a constant holding one salon's name, phone number and
 * address, which was true while there was one salon. The line that made it
 * urgent was "Your appointment at Synergy Salon is confirmed" — which every
 * shop's guests would have received, about a salon in Valrico they had never
 * heard of.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { shopFrom } from '../api/_lib/config.js';

const BARBER = {
  name: "Rico's Barbershop", slug: 'ricos', timezone: 'America/Chicago',
  address: '88 Main St\nAustin, TX 78701', phone: '(512) 555-0110', email: 'hi@ricos.example',
};

test('a shop speaks for itself, not for the first customer', () => {
  const shop = shopFrom(BARBER);
  assert.equal(shop.name, "Rico's Barbershop");
  assert.equal(shop.email, 'hi@ricos.example');
  assert.equal(shop.timezone, 'America/Chicago');
  assert.deepEqual(shop.addressLines, ['88 Main St', 'Austin, TX 78701']);
});

test('the phone becomes a link that dials', () => {
  assert.equal(shopFrom(BARBER).phoneHref, 'tel:+5125550110'.replace('+', ''));
});

test('links use the shop own domain when it has one', () => {
  assert.equal(shopFrom({ ...BARBER, host: 'ricos.com' }).site, 'https://ricos.com');
});

test('a shop with no domain still gets a working link', () => {
  // Most new customers have a Facebook page and a phone number, nothing more.
  assert.equal(shopFrom(BARBER).site, '/s/ricos');
});

test('an address typed on one line is not split into invented ones', () => {
  assert.deepEqual(shopFrom({ address: '88 Main St, Austin TX' }).addressLines,
                   ['88 Main St, Austin TX']);
  assert.deepEqual(shopFrom({}).addressLines, []);
});

test('an empty tenant produces nothing that reads as another shop', () => {
  const shop = shopFrom({});
  assert.equal(shop.phone, '');
  assert.equal(shop.email, '');
  assert.equal(shop.phoneHref, '');
  assert.ok(!/synergy/i.test(JSON.stringify(shop)), 'no shop name should leak into a blank tenant');
});

test('no shop name is hardcoded in the emails or the calendar feed', () => {
  // The guard that stops this coming back. A name in these files is a name
  // every customer's guests will read.
  for (const file of ['api/_lib/email.js', 'api/calendar.js', 'api/_lib/config.js']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      // Comments explain the history on purpose; it is the code that matters.
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      // The sending address is one verified domain for the whole platform,
      // which is deliberate and documented where it is defined.
      .replace(/bookings@\S+/g, '');
    assert.ok(!/Synergy Salon/i.test(src), `${file} still names a shop`);
  }
});
