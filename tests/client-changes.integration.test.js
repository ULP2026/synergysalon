/**
 * The client profile's tags and its Admin history (2026-11-03), against
 * Postgres: tags save as a list with duplicates dropped; every change the
 * team makes to a client's record (tags, notes, contact preferences, card on
 * file, name, phone, status) is on their Activity under Admin, with what it
 * was, what it became and who did it; a change that changes nothing is not.
 *
 * Runs against the seeded tenant with migrations applied (041 included),
 * inside a transaction it rolls back. Test rows are named ZZ.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import {
  addNote, contactDetail, logChanges, setCard, setPrefs, setTags,
} from '../api/staff/_routes/contacts.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const isLocal = url?.includes('localhost') || url?.includes('127.0.0.1');

test('tags and every change to a client are kept, with who made them', { skip }, async () => {
  const c = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query('BEGIN');
    const { rows: t } = await c.query("SELECT id, timezone FROM tenants WHERE slug = 'synergy'");
    const tenant = t[0];
    const { rows: u } = await c.query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role)
       VALUES ($1, 'zz-changes@example.com', 'x', 'ZZ Desk', 'front_desk') RETURNING id`,
      [tenant.id],
    );
    const user = { id: u[0].id, name: 'ZZ Desk', timezone: tenant.timezone };
    const { rows: ct } = await c.query(
      `INSERT INTO contacts (tenant_id, name, phone, email, source, created_by)
       VALUES ($1, 'ZZ Change Client', '8135550144', 'zz-change@example.com', 'Front desk', $2) RETURNING id`,
      [tenant.id, user.id],
    );
    const id = ct[0].id;

    // Tags: trimmed, duplicates dropped whatever their capitals, kept in order.
    const r = await setTags(tenant.id, { id, tags: [' VIP ', 'Curly  cut', 'vip'] }, c, user);
    assert.deepEqual(r.tags, ['VIP', 'Curly cut']);
    await setTags(tenant.id, { id, tags: ['Curly cut', 'Allergic'] }, c, user);
    await assert.rejects(setTags(tenant.id, { id, tags: ['x'.repeat(31)] }, c, user), /30 characters/);
    await assert.rejects(setTags(tenant.id, { id, tags: 'VIP' }, c, user), /list/);

    await addNote(tenant.id, user, { id, note: 'Prefers mornings.' }, c);
    await setPrefs(tenant.id, { id, email: false, sms: true }, c, user);
    // Nothing changed for texts, so only the email switch is in the history.
    await setCard(tenant.id, { id, cardOnFile: true }, c, user);
    // The edit form's save, as the PATCH handler logs it.
    await logChanges(c.query.bind(c), tenant.id, id, user, [
      { field: 'name', old: 'ZZ Change Client', new: 'ZZ Changed Client' },
      { field: 'phone', old: '8135550144', new: '8135550199' },
      { field: 'email', old: 'zz-change@example.com', new: 'zz-change@example.com' },
      { field: 'status', old: 'new', new: 'won' },
    ]);

    const d = await contactDetail(tenant.id, id, c);
    assert.deepEqual(d.contact.tags, ['Curly cut', 'Allergic']);
    const admin = d.activity.filter((e) => e.type === 'admin');
    const lines = admin.map((e) => [e.title, e.detail]);
    for (const want of [
      ['Tag added', 'VIP'], ['Tag added', 'Curly cut'], ['Tag removed', 'VIP'], ['Tag added', 'Allergic'],
      ['Note added', 'Prefers mornings.'], ['Email follow-ups turned off', ''], ['Card on file added', ''],
      ['Name updated', 'ZZ Change Client → ZZ Changed Client'],
      ['Phone updated', '(813) 555-0144 → (813) 555-0199'],
      ['Status changed', 'New → Client'],
    ]) assert.ok(lines.some(([a, b]) => a === want[0] && b === want[1]), `missing ${want.join(': ')}`);
    assert.ok(!lines.some(([a]) => a === 'Email updated'), 'an unchanged email is not a change');
    assert.ok(!lines.some(([a]) => a === 'Text messages turned on'), 'an unchanged switch is not a change');
    assert.equal(admin.length, 10);
    assert.ok(admin.every((e) => e.by.kind === 'staff' && e.by.id === user.id && e.by.name === 'ZZ Desk'));
    assert.equal(d.people[user.id].name, 'ZZ Desk');

    // Made by a team member: "Client Created", by them.
    const created = d.activity.find((e) => e.title === 'Client Created');
    assert.equal(created.by.id, user.id);
    assert.ok(!d.activity.some((e) => e.title === 'Added as a contact'));
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});
