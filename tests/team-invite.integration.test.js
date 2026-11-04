/**
 * The Team Member Invitation automation (asked for 2026-11-04): inviting
 * somebody sends Karen's welcome by email and by text, the email is kept in
 * Email History and both in the automation's Sent History, the setup link
 * (a credential) is in neither log, and switching the automation off stops
 * both.
 *
 *   TEST_DATABASE_URL=postgres://… npm test
 *
 * Drives the real /api/staff/team handler as the owner, with a stand-in for
 * the email provider and for Twilio. Test rows are named ZZ and removed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSession } from '../api/_lib/auth.js';
import { ensureSchema } from '../api/_lib/ensure-schema.js';
import { query } from '../api/_lib/db.js';
import { textInvite } from '../api/_lib/sms-notify.js';
import { automationSends, history, sentMessage } from '../api/staff/_routes/business.js';
import team from '../api/staff/_routes/team.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

function call(method, cookie, body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }); },
    };
    team({ method, headers: { cookie, host: 'app.synergysalon.com' }, body }, res);
  });
}

async function cleanup(tenantId) {
  await query("DELETE FROM message_sends WHERE to_email LIKE 'zz-invite-%@example.com'");
  await query("DELETE FROM team_texts WHERE to_name LIKE 'ZZ Invite%'");
  await query("DELETE FROM stylists WHERE name LIKE 'ZZ Invite%'");
  await query("DELETE FROM staff_users WHERE email LIKE 'zz-invite-%@example.com'");
  if (tenantId) await query("UPDATE tenants SET automations_off = array_remove(automations_off, 'team_invite') WHERE id = $1", [tenantId]);
}

test('inviting a team member sends and logs Karen\'s welcome, without the link', { skip }, async () => {
  await ensureSchema();
  const { rows: [t] } = await query("SELECT id, name, karen_phone FROM tenants WHERE slug = 'synergy'");
  await cleanup(t.id);
  // The email provider, stood in: every message it is handed is kept here.
  const mails = [];
  const savedKey = process.env.RESEND_API_KEY;
  const savedClient = globalThis.__synergyResend;
  process.env.RESEND_API_KEY = 're_test';
  globalThis.__synergyResend = { emails: { send: async (m) => { mails.push(m); return { error: null }; } } };
  try {
    const owner = (await query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role)
       VALUES ($1, 'zz-invite-owner@example.com', 'x', 'ZZ Invite Owner', 'owner') RETURNING *`, [t.id],
    )).rows[0];
    const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } };
    await createSession(res, owner);
    const cookie = String(res.headers['set-cookie']).split(';')[0];

    // Only the four things the form asks for.
    const made = await call('POST', cookie, {
      action: 'create', name: 'ZZ Invite Nina', email: 'zz-invite-nina@example.com', phone: '(813) 555-0144', role: 'stylist',
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const inv = made.body.invite;
    assert.equal(inv.emailed, true);
    assert.equal(inv.off, false);
    assert.equal(inv.hasPhone, true);
    assert.match(inv.link, /\/invite\?t=/);

    // The email went to them, from Karen, with their link in it.
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'zz-invite-nina@example.com');
    assert.ok(mails[0].html.includes(inv.link), 'the email carries the setup link');
    assert.match(mails[0].text, /I.m Karen/);

    // Kept in Email History, sent, with no link anywhere in the row.
    const { rows: logged } = await query(
      "SELECT kind, status, subject, body FROM message_sends WHERE to_email = 'zz-invite-nina@example.com'",
    );
    assert.equal(logged.length, 1);
    assert.equal(logged[0].kind, 'team_invite');
    assert.equal(logged[0].status, 'sent');
    assert.ok(!JSON.stringify(logged[0]).includes(inv.link.split('t=')[1]), 'the token is never logged');
    const page = await history({ id: t.id }, null, { kind: 'team_invite' });
    assert.ok(page.sends.some((x) => x.email === 'zz-invite-nina@example.com' && x.status === 'sent'));
    const opened = await sentMessage(page.sends.find((x) => x.email === 'zz-invite-nina@example.com').id, { id: t.id, name: t.name });
    assert.equal(opened.kind, 'team_invite');
    assert.ok(!opened.html.includes('invite?t='), 'the rebuilt email has no working link');

    // The text, through a stand-in for Twilio, kept for Sent History without the link.
    await query("UPDATE tenants SET karen_phone = COALESCE(karen_phone, '+18135550199') WHERE id = $1", [t.id]);
    const texts = [];
    const r = await textInvite({ tenant: { id: t.id, name: t.name }, phone: '8135550144', name: 'ZZ Invite Nina', link: inv.link, expiresDays: 7 },
      { send: async (m) => { texts.push(m); return { sid: 'SMx' }; } });
    assert.equal(r.texted, true);
    assert.ok(texts[0].body.includes(inv.link));
    const sends = await automationSends({ id: t.id }, 'team_invite');
    const sms = sends.sends.find((x) => x.channel === 'sms' && x.name === 'ZZ Invite Nina');
    const mail = sends.sends.find((x) => x.channel === 'email' && x.to === 'zz-invite-nina@example.com');
    assert.ok(sms && mail, 'both the email and the text are in the automation\'s Sent History');
    const { rows: [kept] } = await query("SELECT body FROM team_texts WHERE to_name = 'ZZ Invite Nina'");
    assert.ok(!kept.body.includes(inv.link) && kept.body.includes('[setup link]'));

    // Switched off in Automations: nothing goes, and the owner is handed the link.
    await query("UPDATE tenants SET automations_off = array_append(automations_off, 'team_invite') WHERE id = $1", [t.id]);
    const off = await call('POST', cookie, {
      action: 'create', name: 'ZZ Invite Off', email: 'zz-invite-off@example.com', phone: '(813) 555-0145', role: 'front_desk',
    });
    assert.equal(off.status, 201);
    assert.equal(off.body.invite.emailed, false);
    assert.equal(off.body.invite.off, true);
    assert.equal(mails.length, 1, 'no email while the automation is off');
    const offText = await textInvite({ tenant: { id: t.id, automations_off: ['team_invite'] }, phone: '8135550145', name: 'ZZ Invite Off', link: 'x' },
      { send: async () => { throw new Error('must not send'); } });
    assert.equal(offText.skipped, 'off');
  } finally {
    await cleanup(t.id);
    await query('UPDATE tenants SET karen_phone = $2 WHERE id = $1', [t.id, t.karen_phone]);
    if (savedKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = savedKey;
    globalThis.__synergyResend = savedClient;
  }
});
