/**
 * Karen's texts to clients (sms-notify.js), and stylists changing their
 * clients' appointments by text (asked for 2026-10-28).
 *
 * Texts go only to a client whose consent is on record, from Karen's number,
 * beside the email of the same kind; STOP takes the consent away. A stylist
 * sees and changes only their own clients' visits; the admin, anyone's.
 * Claude is a scripted stand-in and Twilio a stubbed fetch: nothing leaves
 * the machine. Test people are named ZZ.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';
import pg from 'pg';

import { DEFAULT_TZ } from '../api/_lib/config.js';
import { sendConfirmation } from '../api/_lib/email.js';
import { karenReply } from '../api/_lib/karen-sms.js';
import { segments } from '../api/_lib/sms-length.js';
import { appointmentText, recordConsent, revokeConsent, textGuest } from '../api/_lib/sms-notify.js';
import { tenantForUser } from '../api/_lib/tenant.js';
import { makeBookable } from './bookable.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const isLocal = url?.includes('localhost') || url?.includes('127.0.0.1');
const connect = async () => {
  const c = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await c.connect();
  return c;
};

/** Twilio's keys for the length of `fn`, then put back as they were. */
async function withTwilio(fn) {
  const saved = { sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN };
  process.env.TWILIO_ACCOUNT_SID = 'ACzz';
  process.env.TWILIO_AUTH_TOKEN = 'zz';
  try { return await fn(); } finally {
    for (const [k, v] of [['TWILIO_ACCOUNT_SID', saved.sid], ['TWILIO_AUTH_TOKEN', saved.token]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('each appointment text is Karen introducing herself and the salon, and says how to stop', () => {
  const tomorrow = DateTime.now().setZone(DEFAULT_TZ).plus({ days: 1 }).set({ hour: 14, minute: 0 });
  const appt = { starts_at: tomorrow.toISO(), guest_name: 'ZZ Maria Lopez', service_name: 'Haircut', stylist_name: 'Dina Lara' };
  const tenant = { name: 'Synergy Salon', timezone: DEFAULT_TZ, phone: '813.654.2055' };
  for (const kind of ['confirmation', 'reschedule', 'cancellation', 'reminder']) {
    const text = appointmentText(kind, appt, tenant);
    assert.match(text, /^Hey! This is Karen from Synergy Salon\. /, kind);
    assert.match(text, /Reply STOP to opt out\.$/, kind);
    assert.match(text, /Haircut with Dina/, kind);
    assert.equal(segments(text), 1, `${kind} fits one text`);
  }
  assert.match(appointmentText('reminder', appt, tenant), /Reminder, ZZ: your Haircut with Dina is tomorrow, /);
  assert.equal(appointmentText('review', appt, tenant), null, 'follow-ups are not texted');
});

test('a text goes only to a client whose consent is on record, and STOP ends it', { skip }, async () => {
  const client = await connect();
  let tenantId;
  try {
    ({ rows: [{ id: tenantId }] } = await client.query(
      "INSERT INTO tenants (slug, name, karen_phone, timezone) VALUES ($1, 'ZZ Text Salon', '+18138514556', $2) RETURNING id",
      [`zz-texts-${Date.now()}`, DEFAULT_TZ],
    ));
    const { rows: [c] } = await client.query(
      "INSERT INTO contacts (tenant_id, name, email, phone) VALUES ($1, 'ZZ Text Client', '', '(813) 555-0170') RETURNING id",
      [tenantId],
    );
    const appt = {
      ref: 'ZZTXT1', contact_id: c.id, guest_name: 'ZZ Text Client', guest_email: '',
      starts_at: DateTime.now().plus({ days: 3 }).toISO(), service_name: 'Haircut', stylist_name: 'Dina Lara',
    };
    const tenant = { id: tenantId, name: 'ZZ Text Salon', timezone: DEFAULT_TZ };
    const sent = [];
    const send = async (m) => { sent.push(m); };

    await withTwilio(async () => {
      assert.deepEqual(await textGuest('confirmation', appt, tenant, { send }), { skipped: 'no consent' },
        'a number on file is not consent');
      assert.equal(await recordConsent(client, tenantId, '8135550170', 'Website opt-in form'), 1);
      assert.deepEqual(await textGuest('confirmation', appt, tenant, { send }), { texted: true });
      assert.equal(sent[0].to, '+18135550170');
      assert.equal(sent[0].from, '+18138514556', "from Karen's number");
      assert.match(sent[0].body, /^Hey! This is Karen from ZZ Text Salon\. You're booked, ZZ!/);

      // Texts switched off on the client's profile: none, even with consent.
      await client.query('UPDATE contacts SET sms_ok = false WHERE id = $1', [c.id]);
      assert.deepEqual(await textGuest('reminder', appt, tenant, { send }), { skipped: 'switched off' });
      await client.query('UPDATE contacts SET sms_ok = true WHERE id = $1', [c.id]);

      // Through the email path, as every booking reaches it: no email address,
      // and the client still gets the text. fetch is Twilio, stubbed.
      const realFetch = globalThis.fetch;
      const calls = [];
      globalThis.fetch = async (u, init) => { calls.push({ u, body: String(init.body) }); return { ok: true, json: async () => ({}) }; };
      try {
        const out = await sendConfirmation(appt, tenant);
        assert.equal(out.texted, true);
        assert.match(calls[0].u, /Accounts\/ACzz\/Messages\.json$/);
        assert.match(calls[0].body, /To=%2B18135550170/);
      } finally { globalThis.fetch = realFetch; }

      assert.equal(await revokeConsent(client, tenantId, '8135550170'), 1);
      assert.deepEqual(await textGuest('reminder', appt, tenant, { send }), { skipped: 'no consent' }, 'STOP means no more');
    });
  } finally {
    if (tenantId) {
      await client.query('DELETE FROM contacts WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
    await client.end();
  }
});

/** A stand-in for the Anthropic client. */
function fakeClaude(script) {
  const calls = [];
  return {
    calls,
    messages: { async create(params) { calls.push(JSON.parse(JSON.stringify(params))); return script(params, calls.length); } },
  };
}
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const use = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu_${name}`, name, input }] });
/** What the last tool answered, as the model would read it. */
const lastResult = (params) => {
  const last = params.messages[params.messages.length - 1];
  const block = Array.isArray(last.content) ? last.content.find((b) => b.type === 'tool_result') : null;
  return block ? { ...JSON.parse(block.content), is_error: Boolean(block.is_error) } : null;
};

test('a stylist sees the whole salon by text and can cancel any appointment in it', { skip }, async () => {
  const client = await connect();
  client.inTransaction = true;
  try {
    await client.query('BEGIN');
    const { rows: [t] } = await client.query("SELECT id FROM tenants WHERE slug = 'synergy'");
    const tenant = await tenantForUser({ tenant_id: t.id });
    const dina = await makeBookable(client, tenant.id, 'dina');
    const micah = await makeBookable(client, tenant.id, 'micah');
    const { rows: [svc] } = await client.query(
      "SELECT id, duration_min FROM services WHERE tenant_id = $1 AND slug = 'haircuts'", [tenant.id],
    );
    const { rows: [u] } = await client.query(
      `INSERT INTO staff_users (tenant_id, name, email, role, phone, password_hash)
       VALUES ($1, 'ZZ Chair Stylist', 'zz-chair-stylist@example.com', 'stylist', '+1 813 555 0181', 'x') RETURNING id`,
      [tenant.id],
    );
    await client.query('UPDATE stylists SET staff_user_id = $1 WHERE id = $2', [u.id, dina]);
    const book = async (ref, stylistId, name, days) => {
      const { rows: [c] } = await client.query(
        "INSERT INTO contacts (tenant_id, name, email, phone) VALUES ($1, $2, '', '8135550199') RETURNING id", [tenant.id, name],
      );
      const start = DateTime.now().setZone(DEFAULT_TZ).plus({ days }).startOf('day').set({ hour: 13 });
      await client.query(
        `INSERT INTO appointments (tenant_id, ref, stylist_id, service_id, contact_id, starts_at, duration_min,
                                   buffer_min, during, guest_name, guest_email, guest_phone, manage_token, channel)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, 0,
                 tstzrange($6::timestamptz, $6::timestamptz + make_interval(mins => $7::int), '[)'),
                 $8, '', '8135550199', $9, 'staff')`,
        [tenant.id, ref, stylistId, svc.id, c.id, start.toISO(), svc.duration_min, name, `tok-${ref}`],
      );
      return c.id;
    };
    const mine = await book('ZZCHR1', dina, 'ZZ Maria Mine', 3);
    await book('ZZCHR2', micah, 'ZZ Other Client', 3);

    // Every team member, whatever their role, sees the whole salon and may
    // change any of it (2026-10-31); it used to be their own chair only.
    const claude = fakeClaude((params, n) => {
      const facts = params.system[1].text;
      assert.match(facts, /a stylist, who may book new appointments for clients and move or cancel any appointment in the salon/);
      assert.match(facts, /ZZ Other Client: Haircuts? with Micah/, "another stylist's client is listed too");
      const mineAt = Number((facts.match(/(\d+)\. ZZ Maria Mine: Haircuts? with Dina/) || [])[1]);
      assert.ok(mineAt, 'their own client is listed');
      return n === 1 ? use('propose_cancel', { appointment: mineAt }) : say("Cancel ZZ's haircut on Friday? Reply YES to confirm.");
    });
    const ask = await karenReply(tenant, '813-555-0181', 'please cancel Maria on friday', client, { ai: claude });
    assert.match(ask, /Reply YES to confirm/);
    const { rows: [thread] } = await client.query("SELECT state FROM karen_threads WHERE phone = '8135550181'");
    assert.match(thread.state.pending.summary, /^cancel ZZ's Haircuts? with Dina/);

    const done = await karenReply(tenant, '813-555-0181', 'yes', client, { ai: fakeClaude(() => { throw new Error('a yes is not for the model'); }) });
    assert.match(done, /^Done: ZZ Maria Mine's Haircuts? with Dina .* is cancelled\. The client gets the usual notice/);
    const { rows: [a] } = await client.query("SELECT status FROM appointments WHERE ref = 'ZZCHR1'");
    assert.equal(a.status, 'cancelled');
    const { rows: [note] } = await client.query('SELECT notes FROM contacts WHERE id = $1', [mine]);
    assert.match(note.notes, /Cancelled by text with Karen, asked by ZZ Chair Stylist: /);
    const { rows: [other] } = await client.query("SELECT status FROM appointments WHERE ref = 'ZZCHR2'");
    assert.equal(other.status, 'booked');

    // The admin sees the whole salon.
    await client.query(
      `INSERT INTO staff_users (tenant_id, name, email, role, phone, password_hash)
       VALUES ($1, 'ZZ Admin', 'zz-chair-admin@example.com', 'admin', '+1 813 555 0182', 'x')`,
      [tenant.id],
    );
    const adminView = fakeClaude((params) => {
      assert.match(params.system[1].text, /the salon's admin, who may book new appointments for clients and move or cancel any appointment/);
      assert.match(params.system[1].text, /ZZ Other Client: Haircuts? with Micah/);
      return say('You have one appointment ahead.');
    });
    await karenReply(tenant, '8135550182', "what's coming up?", client, { ai: adminView });
    assert.equal(adminView.calls.length, 1);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});

test('a stylist books a new appointment for a client by text, as the front desk does', { skip }, async () => {
  const client = await connect();
  client.inTransaction = true;
  try {
    await client.query('BEGIN');
    const { rows: [t] } = await client.query("SELECT id FROM tenants WHERE slug = 'synergy'");
    const tenant = await tenantForUser({ tenant_id: t.id });
    const dina = await makeBookable(client, tenant.id, 'dina');
    const { rows: [u] } = await client.query(
      `INSERT INTO staff_users (tenant_id, name, email, role, phone, password_hash)
       VALUES ($1, 'ZZ Booking Stylist', 'zz-book-stylist@example.com', 'stylist', '+1 813 555 0183', 'x') RETURNING id`,
      [tenant.id],
    );
    await client.query('UPDATE stylists SET staff_user_id = $1 WHERE id = $2', [u.id, dina]);

    let offered = null;
    const seen = {};
    const claude = fakeClaude((params, n) => {
      if (n === 1) return use('find_times', { service: 'haircuts', stylist: 'dina' });
      if (n === 2) {
        const r = lastResult(params);
        assert.ok(r.times?.length, 'free times for the team');
        offered = r.times[0].start;
        // A client who is not on file: Karen is told to ask for a phone or email.
        return use('propose_booking', { service: 'haircuts', stylist: 'dina', start: offered, name: 'ZZ Brand New' }, 'tu_b1');
      }
      if (n === 3) {
        seen.first = lastResult(params);
        return use('propose_booking', { service: 'haircuts', stylist: 'dina', start: offered, name: 'ZZ Brand New', client_phone: '813-555-0144' }, 'tu_b2');
      }
      seen.second = lastResult(params);
      return say('Book ZZ for a haircut with Dina? Reply YES to confirm.');
    });
    const ask = await karenReply(tenant, '8135550183', 'book ZZ Brand New for a haircut with Dina', client, { ai: claude });
    assert.match(ask, /Reply YES to confirm/);
    assert.equal(seen.first.is_error, true);
    assert.match(seen.first.error, /not on file yet/);
    assert.equal(seen.second.is_error, false);

    const done = await karenReply(tenant, '8135550183', 'yes', client, { ai: fakeClaude(() => { throw new Error('a yes is not for the model'); }) });
    assert.match(done, /^All set: ZZ's Haircuts? with Dina is booked for /);
    const { rows: [a] } = await client.query(
      `SELECT a.channel, a.booked_by, a.status, c.name, c.phone FROM appointments a JOIN contacts c ON c.id = a.contact_id
        WHERE a.guest_name = 'ZZ Brand New'`,
    );
    assert.equal(a.status, 'booked');
    assert.equal(a.channel, 'staff', 'a desk booking');
    assert.equal(a.booked_by, u.id, 'booked by the stylist who asked');
    assert.equal(a.name, 'ZZ Brand New', 'the new client is on file, so the booking shows on Appt. Book');
    assert.match(a.phone, /555.?0144/);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
