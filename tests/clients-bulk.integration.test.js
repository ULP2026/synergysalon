/**
 * Clients, Import and Select (asked for 2026-11-09), through the real
 * /api/staff/contacts handler as the owner: a file of clients and leads is
 * imported with each bad line skipped and said why, and several clients are
 * deleted at once only with the word DELETE.
 *
 * Every row is a "ZZ Bulk" client, removed afterwards.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSession } from '../api/_lib/auth.js';
import { pool } from '../api/_lib/db.js';
import { ensureSchema } from '../api/_lib/ensure-schema.js';
import contacts from '../api/staff/_routes/contacts.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

function call(cookie, method, { body, qs } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }); },
    };
    const raw = body ? JSON.stringify(body) : '';
    const req = {
      method, url: `/api/staff/contacts${qs ? `?${new URLSearchParams(qs)}` : ''}`,
      headers: { cookie, host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' },
      body: body || undefined,
      async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw); },
    };
    contacts(req, res);
  });
}

async function cleanup(db) {
  await db.query("DELETE FROM contacts WHERE name LIKE 'ZZ Bulk %'");
  await db.query("DELETE FROM staff_sessions WHERE user_id IN (SELECT id FROM staff_users WHERE email = 'zz-bulk-owner@example.com')");
  await db.query("DELETE FROM staff_users WHERE email = 'zz-bulk-owner@example.com'");
}

test('Clients: import a file, then delete several with DELETE', { skip }, async () => {
  await ensureSchema();
  const db = pool();
  await cleanup(db);
  try {
    const { rows: [t] } = await db.query("SELECT id FROM tenants WHERE slug = 'synergy'");
    const owner = (await db.query(
      `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, onboarded_at)
       VALUES ($1, 'zz-bulk-owner@example.com', 'x', 'ZZ Bulk Owner', 'owner', now()) RETURNING *`, [t.id],
    )).rows[0];
    const r0 = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } };
    await createSession(r0, owner);
    const cookie = String(r0.headers['set-cookie']).split(';')[0];

    await db.query(
      "INSERT INTO contacts (tenant_id, name, email, phone) VALUES ($1, 'ZZ Bulk Existing', 'zz-bulk-existing@example.com', '')", [t.id]);

    const imp = await call(cookie, 'POST', { body: { op: 'import', rows: [
      { line: 2, name: 'ZZ Bulk Ana', email: 'ZZ-Bulk-Ana@Example.com', phone: '(813) 555-0101', status: 'Client', tags: 'VIP; Color', fallback: 'lead' },
      { line: 3, name: 'ZZ Bulk Ben', phone: '8135550102', fallback: 'lead' },
      { line: 4, name: '', email: 'nobody@example.com' },
      { line: 5, name: 'ZZ Bulk Cy' },
      { line: 6, name: 'ZZ Bulk Existing', email: 'zz-bulk-existing@example.com' },
      { line: 7, name: 'ZZ Bulk Ana', email: 'zz-bulk-ana@example.com' },
      { line: 8, name: 'ZZ Bulk Dee', email: 'dee@example.com', status: 'contacted', fallback: 'client' },
      { line: 9, name: 'ZZ Bulk Eve', email: 'eve@example.com', fallback: 'client' },
    ] } });
    assert.equal(imp.status, 200, JSON.stringify(imp.body));
    assert.equal(imp.body.added, 4);
    assert.deepEqual(imp.body.skipped.map((x) => [x.line, x.reason]), [
      [4, 'No name'], [5, 'No email or phone'], [6, 'Already a client'], [7, 'Listed twice in this file'],
    ]);

    const list = await call(cookie, 'GET', { qs: { q: 'ZZ Bulk', limit: '50', sort: 'name' } });
    const by = Object.fromEntries(list.body.contacts.map((c) => [c.name, c]));
    assert.equal(by['ZZ Bulk Ana'].status, 'won');
    assert.equal(by['ZZ Bulk Ana'].email, 'zz-bulk-ana@example.com');
    assert.deepEqual(by['ZZ Bulk Ana'].tags, ['VIP', 'Color']);
    assert.equal(by['ZZ Bulk Ana'].source, 'Import');
    assert.equal(by['ZZ Bulk Ben'].status, 'new');
    assert.equal(by['ZZ Bulk Dee'].status, 'contacted');
    assert.equal(by['ZZ Bulk Eve'].status, 'won');
    assert.ok(by['ZZ Bulk Ana'].createdAt);

    const ids = [by['ZZ Bulk Ana'].id, by['ZZ Bulk Ben'].id];
    const noWord = await call(cookie, 'DELETE', { body: { ids } });
    assert.equal(noWord.status, 400);
    const wrong = await call(cookie, 'DELETE', { body: { ids, confirm: 'delete' } });
    assert.equal(wrong.status, 400);
    const del = await call(cookie, 'DELETE', { body: { ids, confirm: 'DELETE' } });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(del.body.deleted, 2);
    const after = await call(cookie, 'GET', { qs: { q: 'ZZ Bulk', limit: '50' } });
    assert.equal(after.body.contacts.length, 3); // Existing, Dee and Eve
    assert.ok(!after.body.contacts.some((c) => ids.includes(c.id)));
  } finally {
    await cleanup(db);
  }
});
