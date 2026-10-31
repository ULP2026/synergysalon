/**
 * Karen's message history (asked for 2026-10-31): every message between a
 * team member and Karen, in the app's chat or by text, kept for the owner
 * to read in Settings, Karen AI, Message History.
 *
 * Writing never gets in the way of Karen: a failure is logged and ignored,
 * and before the table exists (migration 038, also in ensure-schema) there
 * is simply nothing kept. Reading is for the admin only (karen.js checks).
 */
import { query } from './db.js';

const MAX_BODY = 4000;
const MAX_BATCH = 50;

/**
 * Keep some messages. `entries` are { role: 'user' | 'karen', text, at? };
 * `at`, when sent by the app, keeps the order a quick exchange happened in.
 */
export async function logKaren(tenantId, user, channel, entries, db = null) {
  const rows = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && (e.role === 'user' || e.role === 'karen') && typeof e.text === 'string' && e.text.trim())
    .slice(0, MAX_BATCH);
  if (!rows.length || !user?.id) return 0;
  const q = db ? db.query.bind(db) : query;
  try {
    for (const e of rows) {
      const at = e.at && !Number.isNaN(Date.parse(e.at)) && Math.abs(Date.now() - Date.parse(e.at)) < 6 * 3600_000
        ? new Date(e.at).toISOString() : null;
      await q(
        `INSERT INTO karen_messages (tenant_id, user_id, who_name, channel, role, body, created_at)
         VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, COALESCE($7::timestamptz, now()))`,
        [tenantId, user.id, user.name || null, channel, e.role, e.text.trim().slice(0, MAX_BODY), at],
      );
    }
    return rows.length;
  } catch (err) {
    if (err.code !== '42P01') console.error('karen-log failed', err.message);
    return 0;
  }
}

/** Everyone who has talked to Karen, most recent first, with a count and their last message. */
export async function karenPeople(tenantId, db = null) {
  const q = db ? db.query.bind(db) : query;
  try {
    const { rows } = await q(
      `SELECT m.user_id, max(m.who_name) AS who_name, u.name, u.role, u.avatar,
              count(*)::int AS messages, max(m.created_at) AS last_at,
              bool_or(m.channel = 'text') AS texted, bool_or(m.channel = 'app') AS in_app,
              (SELECT l.body FROM karen_messages l
                WHERE l.tenant_id = m.tenant_id AND l.user_id IS NOT DISTINCT FROM m.user_id
                ORDER BY l.created_at DESC, l.id DESC LIMIT 1) AS last_body
         FROM karen_messages m
         LEFT JOIN staff_users u ON u.id = m.user_id
        WHERE m.tenant_id = $1::uuid
        GROUP BY m.tenant_id, m.user_id, u.name, u.role, u.avatar
        ORDER BY max(m.created_at) DESC`,
      [tenantId],
    );
    return rows.map((r) => ({
      id: r.user_id || 'removed',
      name: r.name || r.who_name || 'Removed team member',
      role: r.role || null,
      avatar: r.avatar || null,
      messages: r.messages,
      lastAt: r.last_at,
      lastBody: r.last_body ? String(r.last_body).slice(0, 140) : '',
      channels: [r.in_app ? 'app' : null, r.texted ? 'text' : null].filter(Boolean),
    }));
  } catch (err) {
    if (err.code === '42P01') return [];
    throw err;
  }
}

/** One person's whole history with Karen, oldest first (the latest 1000). */
export async function karenThread(tenantId, userId, db = null) {
  const q = db ? db.query.bind(db) : query;
  const removed = userId === 'removed';
  if (!removed && !/^[0-9a-f-]{36}$/i.test(String(userId))) return [];
  try {
    const { rows } = await q(
      `SELECT * FROM (
         SELECT id, channel, role, body, created_at FROM karen_messages
          WHERE tenant_id = $1::uuid AND ${removed ? 'user_id IS NULL' : 'user_id = $2::uuid'}
          ORDER BY created_at DESC, id DESC LIMIT 1000) t
        ORDER BY created_at, id`,
      removed ? [tenantId] : [tenantId, userId],
    );
    return rows.map((r) => ({ channel: r.channel, role: r.role, text: r.body, at: r.created_at }));
  } catch (err) {
    if (err.code === '42P01') return [];
    throw err;
  }
}
