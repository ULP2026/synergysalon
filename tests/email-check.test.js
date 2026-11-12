/**
 * The email check every booking path uses (asked for 2026-11-12, after a
 * Nov 2 test booking went to "...@gmail.conm" and Sent History said Sent).
 * The shape alone let that through; the ending has to be a real one.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { settledEmail } from '../api/enquiry.js';
import { emailProblem } from '../api/_lib/email-check.js';
import { HttpError, requireEmail } from '../api/_lib/http.js';

test('real addresses pass, whatever their case', () => {
  for (const ok of ['maria@gmail.com', 'Maria.Lopez@Gmail.COM', 'first.last+tag@sub.example.co.uk',
    'x@mail.com', 'x@ymail.com', 'x@icloud.com', 'a@b.co', 'hair@synergysalon.com', 'z@example.xn--p1ai']) {
    assert.equal(emailProblem(ok), null, ok);
  }
});

test('an ending that does not exist is caught, with the likely one offered', () => {
  assert.match(emailProblem('maria@gmail.conm'), /"\.conm".*Did you mean maria@gmail\.com\?/);
  assert.match(emailProblem('maria@gmail.cmo'), /Did you mean maria@gmail\.com\?/);
  assert.match(emailProblem('maria@yahoo.nett'), /Did you mean maria@yahoo\.net\?/);
  assert.match(emailProblem('maria@school.xyzzy'), /"\.xyzzy" is not an email ending/);
});

test('the big providers\' usual slips are caught', () => {
  assert.match(emailProblem('maria@gmail.co'), /Did you mean maria@gmail\.com\?/);
  assert.match(emailProblem('maria@gmial.com'), /Did you mean maria@gmail\.com\?/);
  assert.match(emailProblem('maria@hotmial.com'), /Did you mean maria@hotmail\.com\?/);
  assert.match(emailProblem('maria@yahooo.com'), /Did you mean maria@yahoo\.com\?/);
  // On real country endings, so only the provider list catches them (QC, 2026-11-12).
  for (const [slip, right] of [['yahoo.cm', 'yahoo.com'], ['hotmail.cm', 'hotmail.com'], ['outlook.cm', 'outlook.com'],
    ['aol.cm', 'aol.com'], ['icloud.om', 'icloud.com'], ['gmail.om', 'gmail.com'], ['aol.co', 'aol.com']]) {
    assert.match(emailProblem(`maria@${slip}`), new RegExp(`Did you mean maria@${right.replace('.', '\\.')}\\?`), slip);
  }
  // A real address on those endings is not a provider slip.
  assert.equal(emailProblem('maria@empresa.co'), null);
  assert.equal(emailProblem('maria@company.cm'), null);
});

test('not the shape of an address at all', () => {
  for (const bad of ['', 'maria', 'maria@', '@gmail.com', 'maria@gmail', 'ma ria@gmail.com',
    'maria@@gmail.com', 'maria@-gmail.com', 'maria@gmail..com', 'maria@.gmail.com']) {
    assert.ok(emailProblem(bad), `${bad} should be refused`);
  }
});

test('requireEmail refuses a typo with the reason, and keeps a good address', () => {
  assert.throws(() => requireEmail('zz@gmail.conm'),
    (err) => err instanceof HttpError && err.status === 400 && /Did you mean zz@gmail\.com/.test(err.message));
  assert.equal(requireEmail(' ZZ@Gmail.com '), 'zz@gmail.com');
});

test('the website survey does not take a typo as a finished address', () => {
  assert.equal(settledEmail('zz@gmail.conm'), '');
  assert.equal(settledEmail('zz@gmail.com'), 'zz@gmail.com');
});
