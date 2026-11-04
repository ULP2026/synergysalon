/**
 * What a stylist sees and does in Settings, and what changed on 2026-11-04:
 *
 * - their own switch on an automation stops it for their clients only, and
 *   really stops the email;
 * - Money is their own income, and they can ask to be paid out; the owner
 *   sees the request and marks it paid;
 * - an automation's Sent History is their own clients' only;
 * - Appt. Book leaves out a stylist with no calendar, and one removed from
 *   the team, but their tickets stay on the client;
 * - a client who shares an email with somebody else can still be added.
 *
 * Drives the real handlers with a stand-in for the email provider. Test rows
 * are named ZZ and removed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';

import { createSession } from '../api/_lib/auth.js';
import { pool } from '../api/_lib/db.js';
import { ensureSchema } from '../api/_lib/ensure-schema.js';
import { sendConfirmation } from '../api/_lib/email.js';
import business from '../api/staff/_routes/business.js';
import contacts from '../api/staff/_routes/contacts.js';
import diary from '../api/staff/_routes/diary.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

function call(route, cookie, method, path, body) {
  return new Promise((resolve) => {
    const out = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }); },
    };
    route({ method, url: path, headers: { cookie, host: 'localhost' }, body }, out);
  });
}
async function sessionFor(user) {
  const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } };
  await createSession(res, user);
  return String(res.headers['set-cookie']).split(';')[0];
}
async function cleanup(db) {
  await db.query("DELETE FROM message_sends WHERE to_email LIKE 'zz-st-%@example.com'");
  await db.query("DELETE FROM cashout_requests WHERE staff_name LIKE 'ZZ ST %'");
  await db.query("DELETE FROM appointments WHERE ref LIKE 'ZZST%'");
  await db.query("DELETE FROM contacts WHERE name LIKE 'ZZ ST %'");
  await db.query("UPDATE stylists SET staff_user_id = NULL WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email LIKE 'zz-st-%')");
  await db.query("DELETE FROM stylists WHERE slug LIKE 'zz-st-%'");
  await db.query("DELETE FROM staff_sessions WHERE user_id IN (SELECT id FROM staff_users WHERE email LIKE 'zz-st-%')");
  await db.query("DELETE FROM staff_users WHERE email LIKE 'zz-st-%'");
}

test('a stylist\'s Settings: their own automations, income, cash-outs and clients', { skip }, async () => {
  await ensureSchema();
  const db = pool();
  await cleanup(db);
  const mails = [];
  const savedKey = process.env.RESEND_API_KEY;
  const savedClient = globalThis.__synergyResend;
  process.env.RESEND_API_KEY = 're_test';
  globalThis.__synergyResend = { emails: { send: async (m) => { mails.push(m); return { error: null }; } } };
  try {
    const { rows: [t] } = await db.query("SELECT * FROM tenants WHERE slug = 'synergy'");
    const add = async (email, name, role, ics) => (await db.query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, onboarded_at, google_ics)
       VALUES ($1, $2, 'x', $3, $4, now(), $5) RETURNING *`, [t.id, email, name, role, ics],
    )).rows[0];
    const owner = await add('zz-st-owner@example.com', 'ZZ ST Owner', 'owner', null);
    const nina = await add('zz-st-nina@example.com', 'ZZ ST Nina', 'stylist', 'https://calendar.google.com/calendar/ical/x/private-a/basic.ics');
    const other = await add('zz-st-other@example.com', 'ZZ ST Other', 'stylist', null);
    const chair = async (slug, name, userId) => (await db.query(
      'INSERT INTO stylists (tenant_id, slug, name, active, staff_user_id) VALUES ($1, $2, $3, true, $4) RETURNING id',
      [t.id, slug, name, userId],
    )).rows[0].id;
    const ninaChair = await chair('zz-st-nina', 'ZZ ST Nina', nina.id);
    const otherChair = await chair('zz-st-other', 'ZZ ST Other', other.id);
    const { rows: [svc] } = await db.query(
      "SELECT id, name FROM services WHERE tenant_id = $1 AND owner_staff_id IS NULL ORDER BY sort_order LIMIT 1", [t.id],
    );
    const day = DateTime.now().setZone(t.timezone).plus({ days: 2 }).startOf('day');
    const book = async (ref, stylistId, name, hour, email) => {
      const { rows: [c] } = await db.query(
        "INSERT INTO contacts (tenant_id, name, email, phone) VALUES ($1, $2, $3, '8135550100') RETURNING id", [t.id, name, email],
      );
      const start = day.set({ hour }).toISO();
      const { rows: [a] } = await db.query(
        `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, contact_id, starts_at, duration_min, buffer_min,
                                   during, guest_name, guest_email, guest_phone, manage_token, channel, price_cents)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, 60, 0, tstzrange($6::timestamptz, $6::timestamptz + interval '60 minutes'),
                 $7, $8, '8135550100', $9, 'staff', 6000) RETURNING *`,
        [t.id, ref, stylistId, svc.id, c.id, start, name, email, `tok-${ref}`],
      );
      return { ...a, service_name: svc.name, stylist_name: 'ZZ', contact_id: c.id };
    };
    const ninaVisit = await book('ZZST1', ninaChair, 'ZZ ST Nina Client', 10, 'zz-st-nina-client@example.com');
    const otherVisit = await book('ZZST2', otherChair, 'ZZ ST Other Client', 11, 'zz-st-other-client@example.com');
    const n = await sessionFor(nina);
    const o = await sessionFor(owner);

    // ── automations: her switch is hers, and stops her clients' email ──
    let r = await call(business, n, 'GET', '/api/staff/business?automations=1');
    assert.equal(r.status, 200);
    assert.ok(!r.body.kinds.some((k) => k.kind.startsWith('team_invite')), 'the team\'s own automation is the owner\'s');
    r = await call(business, n, 'PATCH', '/api/staff/business', { automation: 'confirmation', on: false });
    assert.equal(r.status, 200);
    assert.equal(r.body.mine, true);
    const { rows: [salon] } = await db.query('SELECT automations_off FROM tenants WHERE id = $1', [t.id]);
    assert.ok(!(salon.automations_off || []).includes('confirmation'), 'the salon\'s switch is untouched');
    r = await call(business, n, 'GET', '/api/staff/business?automations=1');
    assert.equal(r.body.kinds.find((k) => k.kind === 'confirmation').on, false);
    await sendConfirmation(ninaVisit, t);
    await sendConfirmation(otherVisit, t);
    assert.deepEqual(mails.map((m) => m.to), ['zz-st-other-client@example.com'], 'only the other stylist\'s client is emailed');

    // ── Sent History: her clients only ──
    await call(business, n, 'PATCH', '/api/staff/business', { automation: 'confirmation', on: true });
    await sendConfirmation(ninaVisit, t);
    r = await call(business, n, 'GET', '/api/staff/business?sends=confirmation');
    assert.equal(r.status, 200);
    const names = r.body.sends.map((x) => x.to);
    assert.ok(names.includes('zz-st-nina-client@example.com'));
    assert.ok(!names.includes('zz-st-other-client@example.com'), 'no other chair\'s sends');
    r = await call(business, o, 'GET', '/api/staff/business?sends=confirmation');
    assert.ok(r.body.sends.some((x) => x.to === 'zz-st-other-client@example.com'), 'the owner sees everyone\'s');

    // ── Money: her income only; cash out, and the owner settles it ──
    const from = day.startOf('month').toISODate();
    const to = day.endOf('month').toISODate();
    r = await call(business, n, 'GET', `/api/staff/business?finance=1&from=${from}&to=${to}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.own, true);
    assert.deepEqual(r.body.stylists.map((x) => x.name), ['ZZ ST Nina']);
    r = await call(business, n, 'PATCH', '/api/staff/business', { cashout: { amount: 120.5, note: 'ZZ tips' } });
    assert.equal(r.status, 201);
    r = await call(business, n, 'GET', '/api/staff/business?cashouts=1');
    assert.equal(r.body.canDecide, false);
    const mine = r.body.requests.find((x) => x.note === 'ZZ tips');
    assert.equal(mine.amountCents, 12050);
    assert.equal(mine.status, 'requested');
    assert.equal((await call(business, n, 'PATCH', '/api/staff/business', { cashoutId: mine.id, status: 'paid' })).status, 403);
    r = await call(business, o, 'PATCH', '/api/staff/business', { cashoutId: mine.id, status: 'paid' });
    assert.equal(r.status, 200);
    r = await call(business, n, 'GET', '/api/staff/business?cashouts=1');
    assert.equal(r.body.requests.find((x) => x.id === mine.id).status, 'paid');
    // The salon's profile stays the owner's.
    assert.equal((await call(business, n, 'GET', '/api/staff/business')).status, 403);

    // ── Appt. Book: no calendar, or removed, is left off; the ticket stays ──
    const d = await call(diary, o, 'GET', `/api/staff/diary?date=${day.toISODate()}`);
    const refs = d.body.appointments.map((a) => a.ref);
    assert.ok(refs.includes('ZZST1'), 'a stylist with a calendar is on the book');
    assert.ok(!refs.includes('ZZST2'), 'one with no calendar is not');
    await db.query("UPDATE stylists SET removed_at = now(), active = false WHERE id = $1", [ninaChair]);
    const d2 = await call(diary, o, 'GET', `/api/staff/diary?date=${day.toISODate()}`);
    assert.ok(!d2.body.appointments.some((a) => a.ref === 'ZZST1'), 'a removed stylist is not on the book');
    const { rows: [kept] } = await db.query("SELECT status FROM appointments WHERE ref = 'ZZST1'");
    assert.equal(kept.status, 'booked', 'the ticket is kept');

    // ── Add client: a shared email is somebody else, not a duplicate ──
    r = await call(contacts, o, 'POST', '/api/staff/contacts', { name: 'ZZ ST Marian', email: 'zz-st-nina-client@example.com', phone: '8135451811' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await call(contacts, o, 'POST', '/api/staff/contacts', { name: 'zz st marian ', email: 'zz-st-nina-client@example.com' });
    assert.equal(r.status, 409, 'the same name and email is the same client');
  } finally {
    await cleanup(db);
    if (savedKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = savedKey;
    globalThis.__synergyResend = savedClient;
  }
});
