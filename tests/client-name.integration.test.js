/**
 * A client's name is the one on their record (Luis, 2026-11-13: "Kristine
 * Dorfner Dorfner" on Home's New bookings and Coming up). Home named a
 * visit by the name typed at booking, so a slip there outlived fixing the
 * client. Now Home names it by the client record, and correcting the client
 * corrects the bookings made under the old name too (their emails, texts
 * and Google copies use it). Driven through the real handlers; test rows
 * are named ZZ and removed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';

import { createSession } from '../api/_lib/auth.js';
import { pool } from '../api/_lib/db.js';
import { ensureSchema } from '../api/_lib/ensure-schema.js';
import contacts from '../api/staff/_routes/contacts.js';
import home from '../api/staff/_routes/home.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

function call(route, cookie, method, url, body) {
  return new Promise((resolve) => {
    const out = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }); },
    };
    route({ method, url, headers: { cookie, host: 'localhost' }, body }, out);
  });
}
async function sessionFor(user) {
  const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } };
  await createSession(res, user);
  return String(res.headers['set-cookie']).split(';')[0];
}
async function cleanup(db) {
  await db.query("DELETE FROM contact_changes WHERE contact_id IN (SELECT id FROM contacts WHERE email = 'zz-name@example.com')").catch(() => {});
  await db.query("DELETE FROM appointments WHERE ref LIKE 'ZZNM%'");
  await db.query("DELETE FROM contacts WHERE email = 'zz-name@example.com'");
  await db.query("DELETE FROM staff_sessions WHERE user_id IN (SELECT id FROM staff_users WHERE email = 'zz-name-owner@example.com')");
  await db.query("DELETE FROM staff_users WHERE email = 'zz-name-owner@example.com'");
}

test('Home names a visit by the client record, and a corrected name reaches the bookings', { skip }, async () => {
  await ensureSchema();
  const db = pool();
  await cleanup(db);
  try {
    const { rows: [t] } = await db.query("SELECT id FROM tenants WHERE slug = 'synergy'");
    const { rows: [owner] } = await db.query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, onboarded_at)
       VALUES ($1, 'zz-name-owner@example.com', 'x', 'ZZ Name Owner', 'owner', now()) RETURNING *`, [t.id],
    );
    const cookie = await sessionFor(owner);
    const { rows: [st] } = await db.query('SELECT id FROM stylists WHERE tenant_id = $1 AND active ORDER BY sort_order LIMIT 1', [t.id]);
    const { rows: [svc] } = await db.query('SELECT id FROM services WHERE tenant_id = $1 AND active ORDER BY sort_order LIMIT 1', [t.id]);
    const typo = 'ZZ Kristine Dorf Dorf';
    const { rows: [c] } = await db.query(
      `INSERT INTO contacts (tenant_id, name, email, phone) VALUES ($1, $2, 'zz-name@example.com', '8135550177') RETURNING id`,
      [t.id, typo],
    );
    // Soon enough to be first in Coming up, made just now for New bookings.
    const start = DateTime.now().plus({ minutes: 3 }).toISO();
    await db.query(
      `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, contact_id, starts_at, duration_min, buffer_min,
                                 during, guest_name, guest_email, manage_token, channel)
       VALUES ($1, 'ZZNM1', $2, $3, $4, $5::timestamptz, 60, 0, tstzrange($5::timestamptz, $5::timestamptz + interval '60 minutes'),
               $6, 'zz-name@example.com', 'tok-zznm1', 'online')`,
      [t.id, st.id, svc.id, c.id, start, typo],
    );

    // The client record is corrected in the database alone (as an import or
    // an older edit would have left it): Home still shows the right name.
    await db.query("UPDATE contacts SET name = 'ZZ Kristine Dorf' WHERE id = $1", [c.id]);
    const h = await call(home, cookie, 'GET', '/api/staff/home');
    assert.equal(h.status, 200);
    const coming = h.body.upcoming.find((a) => a.ref === 'ZZNM1');
    assert.equal(coming?.guestName, 'ZZ Kristine Dorf', 'Coming up');
    const made = h.body.newBookings.items.find((a) => a.ref === 'ZZNM1');
    assert.equal(made?.guestName, 'ZZ Kristine Dorf', 'New bookings');

    // Correcting the client in the app carries the name onto the booking.
    await db.query('UPDATE contacts SET name = $2 WHERE id = $1', [c.id, typo]);
    const r = await call(contacts, cookie, 'PATCH', '/api/staff/contacts', {
      id: c.id, name: 'ZZ Kristine Dorf', email: 'zz-name@example.com', phone: '8135550177',
    });
    assert.equal(r.status, 200);
    const { rows: [a] } = await db.query("SELECT guest_name FROM appointments WHERE ref = 'ZZNM1'");
    assert.equal(a.guest_name, 'ZZ Kristine Dorf');
  } finally {
    await cleanup(db);
  }
});
