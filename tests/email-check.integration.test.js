/**
 * A mistyped email is refused at both booking doors (2026-11-12), through the
 * real handlers: the website survey (/api/enquiry) and the front desk
 * (/api/staff/book). The survey also holds the booking while the box holds a
 * slip, so a guest is never booked with no address they can be reached on.
 * Test rows are named ZZ and removed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';

import { createSession } from '../api/_lib/auth.js';
import { pool } from '../api/_lib/db.js';
import enquiry from '../api/enquiry.js';
import book from '../api/staff/_routes/book.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

function call(route, { cookie = '', url, body }) {
  return new Promise((resolve) => {
    const out = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }); },
    };
    route({ method: 'POST', url, headers: { cookie, host: 'localhost', origin: 'http://localhost' }, body }, out);
  });
}

async function cleanup(db) {
  await db.query("DELETE FROM appointments WHERE guest_name LIKE 'ZZ Email %'");
  await db.query("DELETE FROM contacts WHERE name LIKE 'ZZ Email %'");
  await db.query("DELETE FROM staff_sessions WHERE user_id IN (SELECT id FROM staff_users WHERE email = 'zz-email-owner@example.com')");
  await db.query("DELETE FROM staff_users WHERE email = 'zz-email-owner@example.com'");
}

test('a typo like ".conm" is refused at the desk and on the website', { skip }, async () => {
  const db = pool();
  await cleanup(db);
  try {
    const { rows: [t] } = await db.query("SELECT id, timezone FROM tenants WHERE slug = 'synergy'");
    const day = DateTime.now().setZone(t.timezone).plus({ days: 9 }).set({ hour: 11, minute: 0, second: 0, millisecond: 0 });

    // The front desk: refused with the reason, nothing booked.
    const { rows: [owner] } = await db.query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, onboarded_at)
       VALUES ($1, 'zz-email-owner@example.com', 'x', 'ZZ Email Owner', 'owner', now()) RETURNING *`, [t.id]);
    const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } };
    await createSession(res, owner);
    const cookie = String(res.headers['set-cookie']).split(';')[0];
    const desk = await call(book, {
      cookie, url: '/api/staff/book',
      body: { name: 'ZZ Email Desk', email: 'zz-desk@gmail.conm', phone: '8135550177', service: 'womens-cut', start: day.toISO() },
    });
    assert.equal(desk.status, 400);
    assert.equal(desk.body.code, 'BAD_EMAIL');
    assert.match(desk.body.error, /Did you mean zz-desk@gmail\.com\?/);

    // The website: while typing, the booking waits for a good address.
    const survey = (email, sessionId, complete = false) => call(enquiry, {
      url: '/api/enquiry?salon=synergy',
      body: {
        sessionId, name: 'ZZ Email Guest', email, phone: '8135550178', complete,
        serviceLabel: "Women's cut", services: ["Women's cut"], stylist: 'First available',
        month: day.toFormat('LLLL yyyy'), day: String(day.day), time: day.toFormat('h:mm a'),
      },
    });
    const typing = await survey('zz-guest@gmail.conm', 'zzemailsession01');
    assert.equal(typing.status, 200);
    assert.equal(typing.body.ref, null, 'not booked with a mistyped address');
    const { rows: [lead] } = await db.query("SELECT email FROM contacts WHERE session_id = 'zzemailsession01'");
    assert.equal(lead.email, '', 'the slip is not stored as their address');

    // "Book Me Now!" with the slip still there: told what is wrong.
    const pressed = await survey('zz-guest@gmail.conm', 'zzemailsession01', true);
    assert.equal(pressed.status, 400);
    assert.equal(pressed.body.code, 'BAD_EMAIL');
    assert.match(pressed.body.error, /Did you mean zz-guest@gmail\.com\?/);
    const { rows: none } = await db.query("SELECT 1 FROM appointments WHERE guest_name = 'ZZ Email Guest'");
    assert.equal(none.length, 0);

    // Fixed, the same guest books, with the address on the booking.
    const fixed = await survey('zz-guest@gmail.com', 'zzemailsession01', true);
    assert.equal(fixed.status, 200);
    if (fixed.body.ref) {
      const { rows: [a] } = await db.query('SELECT guest_email FROM appointments WHERE ref = $1', [fixed.body.ref]);
      assert.equal(a.guest_email, 'zz-guest@gmail.com');
    }
  } finally {
    await cleanup(db);
  }
});
