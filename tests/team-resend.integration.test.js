/**
 * Resend Invitation says the right thing for where the person is (asked for
 * 2026-11-04), always from Karen:
 *
 * - link never used: Karen's reminder with a fresh link, and the old link
 *   stops working;
 * - password chosen, setup not finished: Karen's reminder to sign in and
 *   finish, with the step they stopped at and no link that sets a password;
 * - finished: nothing to resend;
 * - a link that ran out shows as "expired" on the Team list.
 *
 * Drives the real team and invite handlers with a stand-in for the email
 * provider. Test rows are named ZZ and removed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSession } from '../api/_lib/auth.js';
import { ensureSchema } from '../api/_lib/ensure-schema.js';
import { query } from '../api/_lib/db.js';
import invite from '../api/staff/_routes/invite.js';
import team from '../api/staff/_routes/team.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

function call(route, method, { cookie = '', body, url = '/' } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }); },
    };
    route({ method, url, headers: { cookie, host: 'app.synergysalon.com' }, body }, res);
  });
}
const tokenOf = (link) => new URL(link).searchParams.get('t');

async function cleanup() {
  await query("DELETE FROM message_sends WHERE to_email LIKE 'zz-resend-%@example.com'");
  await query("DELETE FROM stylists WHERE name LIKE 'ZZ Resend%'");
  await query("DELETE FROM staff_users WHERE email LIKE 'zz-resend-%@example.com'");
}

test('Resend Invitation sends Karen\'s reminder for where they are', { skip }, async () => {
  await ensureSchema();
  await cleanup();
  const mails = [];
  const savedKey = process.env.RESEND_API_KEY;
  const savedClient = globalThis.__synergyResend;
  process.env.RESEND_API_KEY = 're_test';
  globalThis.__synergyResend = { emails: { send: async (m) => { mails.push(m); return { error: null }; } } };
  try {
    const { rows: [t] } = await query("SELECT id FROM tenants WHERE slug = 'synergy'");
    const owner = (await query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role)
       VALUES ($1, 'zz-resend-owner@example.com', 'x', 'ZZ Resend Owner', 'owner') RETURNING *`, [t.id],
    )).rows[0];
    const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } };
    await createSession(res, owner);
    const cookie = String(res.headers['set-cookie']).split(';')[0];

    const made = await call(team, 'POST', { cookie, body: {
      action: 'create', name: 'ZZ Resend Nina', email: 'zz-resend-nina@example.com', phone: '(813) 555-0144', role: 'stylist',
    } });
    assert.equal(made.status, 201);
    const id = made.body.member.id;
    const first = made.body.invite.link;
    assert.equal(made.body.invite.stage, null);
    assert.match(mails.at(-1).subject, /welcome to Synergy Salon/);

    // 1. Unused: a reminder from Karen with a fresh link; the old one is dead.
    let r = await call(team, 'POST', { cookie, body: { id, action: 'reinvite' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.invite.stage, 'invite');
    const fresh = r.body.invite.link;
    assert.notEqual(tokenOf(fresh), tokenOf(first));
    const mail1 = mails.at(-1);
    assert.match(mail1.subject, /^Reminder from Karen/);
    assert.match(mail1.text, /friendly reminder/);
    assert.ok(mail1.html.includes(fresh), 'the reminder carries the fresh link');
    assert.match(mail1.from, /noreply@/);
    const old = await call(invite, 'GET', { url: `/api/staff/invite?t=${tokenOf(first)}` });
    assert.equal(old.status, 410);
    assert.equal(old.body.code, 'INVITE_DEAD');
    assert.match(old.body.error, /sign in/);
    assert.equal((await call(invite, 'GET', { url: `/api/staff/invite?t=${tokenOf(fresh)}` })).status, 200);
    const { rows: [logged] } = await query(
      "SELECT kind, body FROM message_sends WHERE to_email = 'zz-resend-nina@example.com' ORDER BY sent_at DESC LIMIT 1",
    );
    assert.equal(logged.kind, 'team_invite_reminder');
    assert.ok(!logged.body.includes(tokenOf(fresh)), 'the link is never logged');

    // A link that ran out reads as expired on the Team list.
    await query("UPDATE staff_users SET invite_expires_at = now() - interval '1 day' WHERE id = $1", [id]);
    let list = await call(team, 'GET', { cookie });
    assert.equal(list.body.members.find((m) => m.id === id).inviteExpired, true);
    r = await call(team, 'POST', { cookie, body: { id, action: 'reinvite' } });
    assert.equal(r.body.invite.stage, 'invite', 'an expired link is resent fresh');
    list = await call(team, 'GET', { cookie });
    assert.equal(list.body.members.find((m) => m.id === id).inviteExpired, false);

    // 2. Password chosen, stopped on Hours: a reminder to sign in and finish.
    const set = await call(invite, 'POST', { body: { t: tokenOf(r.body.invite.link), password: 'zz-resend-password-1' } });
    assert.equal(set.status, 200);
    await query("UPDATE staff_users SET onboarding_step = 'hours' WHERE id = $1", [id]);
    // The same link again resumes (2026-11-04): who it is for and their step,
    // and it can neither set the password again nor sign anybody in.
    const usedTok = tokenOf(r.body.invite.link);
    const again = await call(invite, 'GET', { url: `/api/staff/invite?t=${usedTok}` });
    assert.equal(again.status, 200);
    assert.equal(again.body.resume, true);
    assert.equal(again.body.step, 'hours');
    assert.equal(again.body.email, 'zz-resend-nina@example.com');
    const twice = await call(invite, 'POST', { body: { t: usedTok, password: 'zz-another-password-2' } });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.code, 'INVITE_RESUME');
    r = await call(team, 'POST', { cookie, body: { id, action: 'reinvite' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.invite.stage, 'finish');
    assert.equal(r.body.invite.step, 'hours');
    const mail2 = mails.at(-1);
    assert.match(mail2.subject, /almost there/);
    assert.match(mail2.text, /Hours & Availability/);
    assert.ok(!/invite\?t=/.test(mail2.html), 'no link that sets a password');
    assert.match(mail2.text, /it.s Karen again/);
    // Their password still works: nothing was reset.
    const { rows: [still] } = await query('SELECT invite_hash FROM staff_users WHERE id = $1', [id]);
    assert.equal(still.invite_hash, null);

    // 3. Finished: nothing to resend, and the link has nothing to resume.
    await query('UPDATE staff_users SET onboarded_at = now() WHERE id = $1', [id]);
    assert.equal((await call(invite, 'GET', { url: `/api/staff/invite?t=${usedTok}` })).status, 410);
    r = await call(team, 'POST', { cookie, body: { id, action: 'reinvite' } });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /finished setting up/);
  } finally {
    await cleanup();
    if (savedKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = savedKey;
    globalThis.__synergyResend = savedClient;
  }
});
