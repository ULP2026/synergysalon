/**
 * A visit of several services is shown whole (asked for 2026-10-31): the
 * emails list every service, not the first. Prices stay out of guest emails
 * while the salon shows clients none (CLIENT_PRICES, config.js); with it on,
 * each line carries its price and a Total follows. No database needed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CLIENT_PRICES } from '../api/_lib/config.js';
import { previewMessage } from '../api/_lib/email.js';
import { visitLines } from '../api/_lib/visit.js';

const BASE = {
  ref: 'ZZVIS1', manage_token: 'x', guest_name: 'ZZ Guest', guest_email: 'zz@example.com',
  stylist_name: 'ZZ Dina', starts_at: '2030-03-05T15:00:00Z', duration_min: 150,
};

test('an email lists every service of the visit, priced only once clients are shown prices', () => {
  const appt = {
    ...BASE,
    service_name: 'ZZ Cut + ZZ Gloss',
    price_cents: 9500,
    lines: [
      { slug: 'zz-cut', name: 'ZZ Cut', priceCents: 6500, durationMin: 60 },
      { slug: 'zz-gloss', name: 'ZZ Gloss', priceCents: 3000, durationMin: 45 },
    ],
  };
  for (const kind of ['confirmation', 'reminder', 'reschedule', 'cancellation']) {
    const m = previewMessage(kind, appt, { name: 'ZZ Salon', timezone: 'America/New_York' }, '2030-03-04T15:00:00Z');
    if (CLIENT_PRICES) {
      assert.match(m.text, /Services: ZZ Cut · \$65\.00\nZZ Gloss · \$30\.00/, kind);
      assert.match(m.text, /Total: \$95\.00/, kind);
    } else {
      assert.match(m.text, /Services: ZZ Cut\nZZ Gloss/, kind);
      assert.ok(!/\$\d/.test(m.text), `${kind} shows the guest no price`);
    }
    assert.ok(m.html.includes('ZZ Gloss'), `${kind} html names the second service`);
  }
});

test('one service reads as before: Service, and Price when clients are shown prices', () => {
  const m = previewMessage('confirmation', {
    ...BASE, service_name: 'ZZ Cut', price_cents: 6500,
    lines: [{ name: 'ZZ Cut', priceCents: 6500, durationMin: 60 }],
  }, { name: 'ZZ Salon' });
  assert.match(m.text, /Service: ZZ Cut/);
  assert.equal(/Price: \$65\.00/.test(m.text), CLIENT_PRICES);
  assert.ok(!/Total:/.test(m.text));
});

test('without itemized lines, the visit name still gives every service, unpriced', () => {
  assert.deepEqual(visitLines(null, 'ZZ Cut + ZZ Gloss').map((l) => [l.name, l.priceCents]),
    [['ZZ Cut', null], ['ZZ Gloss', null]]);
  const m = previewMessage('confirmation', { ...BASE, service_name: 'ZZ Cut + ZZ Gloss', price_cents: 9500 },
    { name: 'ZZ Salon' });
  assert.match(m.text, /Services: ZZ Cut\nZZ Gloss/);
  assert.equal(/Total: \$95\.00/.test(m.text), CLIENT_PRICES);
});
