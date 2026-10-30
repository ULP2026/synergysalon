/**
 * Every email a client is sent is on their Activity, once, with its subject,
 * when and whether it went (asked for 2026-10-31), and Email History says
 * the same. The email provider is a stand-in: nothing is really sent.
 *
 * Runs in a throwaway ZZ tenant and removes it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';

import { createBooking } from '../api/_lib/booking.js';
import { pool } from '../api/_lib/db.js';
import { MESSAGE_KINDS, sendCancellation, sendConfirmation, sendReminder } from '../api/_lib/email.js';
import { history, sentMessage } from '../api/staff/_routes/business.js';
import { EMAIL_KIND, contactDetail } from '../api/staff/_routes/contacts.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
const TZ = 'America/New_York';
let DAY = DateTime.now().setZone(TZ).plus({ days: 20 }).startOf('day');
while (DAY.weekday !== 3) DAY = DAY.plus({ days: 1 });

const cleanup = () => pool().query("DELETE FROM tenants WHERE slug = 'zz-mail'");

/** The provider: answers as Resend does, refusing whatever `refuse` says. */
let refuse = null;
const sent = [];
function stubProvider() {
  process.env.RESEND_API_KEY = 'zz-test';
  globalThis.__synergyResend = {
    emails: {
      async send(m) {
        if (refuse && refuse(m)) return { error: { message: 'ZZ mailbox does not exist' } };
        sent.push(m);
        return { error: null };
      },
    },
  };
}

test('every email kind has a name for the Activity', () => {
  for (const k of MESSAGE_KINDS) assert.ok(EMAIL_KIND[k], `no name for ${k}`);
});

test('a client\'s emails are on their Activity once each, with subject, time and status', { skip }, async () => {
  await cleanup();
  stubProvider();
  const db = pool();
  try {
    const tenant = (await db.query(
      "INSERT INTO tenants (slug, name, timezone) VALUES ('zz-mail', 'ZZ Mail', $1) RETURNING id, slug, name, timezone",
      [TZ],
    )).rows[0];
    await db.query(
      `INSERT INTO services (tenant_id, slug, name, category, duration_min, buffer_min)
       VALUES ($1, 'zz-cut', 'ZZ Cut', 'cuts', 60, 15)`, [tenant.id],
    );
    const st = (await db.query(
      `INSERT INTO stylists (tenant_id, slug, name, service_details)
       VALUES ($1, 'zz-dina', 'ZZ Dina', '{"lunch": false}') RETURNING id`, [tenant.id],
    )).rows[0].id;
    await db.query('INSERT INTO stylist_services (stylist_id, service_id) SELECT $1, id FROM services WHERE tenant_id = $2', [st, tenant.id]);
    await db.query("INSERT INTO stylist_hours (stylist_id, weekday, starts_at, ends_at) VALUES ($1, 3, '09:00', '17:00')", [st]);

    const c = await db.connect();
    let appt;
    try {
      await c.query('BEGIN');
      appt = await createBooking(c, tenant, {
        serviceSlug: 'zz-cut', stylistSlug: 'zz-dina', start: DAY.set({ hour: 10 }).toISO(),
        guestName: 'ZZ Mail Guest', guestEmail: 'zz-mail@example.com', channel: 'staff', minLeadMin: 0,
      });
      await c.query('COMMIT');
    } finally { c.release(); }
    const id = appt.contact_id;

    await sendConfirmation(appt, tenant);
    await sendReminder(appt, tenant);
    // The reminder cron also stamps the appointment; that must not list it twice.
    await db.query('UPDATE appointments SET reminder_sent_at = now() WHERE id = $1', [appt.id]);
    // The provider refuses the cancellation: it is logged, as failed.
    refuse = (m) => /^Cancelled/.test(m.subject);
    await assert.rejects(sendCancellation(appt, tenant), /refused/);
    refuse = null;
    // An email to their address with no appointment behind it (a follow-up).
    await db.query(
      `INSERT INTO message_sends (tenant_id, kind, to_name, to_email, subject)
       VALUES ($1, 'win_back', 'ZZ Mail Guest', 'ZZ-MAIL@example.com', 'It has been a while')`, [tenant.id],
    );
    // Somebody else's email is not theirs.
    await db.query(
      `INSERT INTO message_sends (tenant_id, kind, to_name, to_email, subject)
       VALUES ($1, 'win_back', 'ZZ Other', 'zz-other@example.com', 'It has been a while')`, [tenant.id],
    );

    const d = await contactDetail(tenant.id, id);
    const mails = d.activity.filter((e) => e.type === 'email');
    assert.deepEqual(mails.map((e) => e.kind).sort(), ['cancellation', 'confirmation', 'reminder', 'win_back'],
      'each email once, the reminder not twice, nobody else\'s');
    const by = Object.fromEntries(mails.map((e) => [e.kind, e]));
    assert.match(by.confirmation.title, /^You are booked in: /, 'titled with the subject as sent');
    assert.equal(by.confirmation.status, 'sent');
    assert.ok(by.confirmation.sentId, 'opens the email');
    assert.ok(!Number.isNaN(Date.parse(by.confirmation.at)), 'with when it was sent');
    assert.equal(by.cancellation.status, 'failed');
    assert.match(by.cancellation.error, /ZZ mailbox does not exist/);
    assert.equal(by.win_back.title, 'It has been a while');
    assert.equal(by.confirmation.detail, 'ZZ Cut with ZZ Dina');

    // Email History and the email's own window say the same.
    const h = await history(tenant, null);
    const failed = h.sends.find((x) => x.kind === 'cancellation');
    assert.equal(failed.status, 'failed');
    const win = await sentMessage(by.cancellation.sentId, tenant);
    assert.equal(win.status, 'failed');
    assert.equal(win.subject, by.cancellation.title);
    assert.equal(sent.length, 2, 'two went: the confirmation and the reminder');
  } finally {
    delete process.env.RESEND_API_KEY;
    globalThis.__synergyResend = undefined;
    await cleanup();
    await pool().end();
    globalThis.__synergyPool = undefined;
  }
});
