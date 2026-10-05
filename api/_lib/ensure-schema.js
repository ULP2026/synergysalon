/**
 * The columns the staff console's profile features write to, added if they
 * are missing.
 *
 * Migrations 010 to 013 and 016 were shipped with "run npm run db:migrate" and the
 * console went live before anyone did, so every save of a username, price
 * or avatar choice failed in production. These are the same statements, all
 * idempotent (IF NOT EXISTS), run once per warm function. db:migrate still
 * records the migrations when it is run; running them again is harmless.
 * Anything that fails is logged and left for db:migrate, never thrown: the
 * console must load whatever state the database is in.
 */
import { query } from './db.js';

const STATEMENTS = [
  'ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS username text',
  "ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS pricing text NOT NULL DEFAULT ''",
  `CREATE UNIQUE INDEX IF NOT EXISTS staff_users_username
     ON staff_users (tenant_id, lower(username)) WHERE username IS NOT NULL`,
  'ALTER TABLE stylists ADD COLUMN IF NOT EXISTS photo text',
  "ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS services jsonb NOT NULL DEFAULT '{}'::jsonb",
  'ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS avatar_style jsonb',
  // 010: a person's Google connection. Connect your tools writes these, and
  // Appt. Book reads them to draw each connected person's column.
  'ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS google_email text',
  'ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS google_refresh_token text',
  'ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS google_access_token text',
  'ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS google_expires_at timestamptz',
  'ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS google_calendar_id text',
  'ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS google_connected_at timestamptz',
  // 016: Stylist as a role, so Clients can offer a filter per stylist.
  "ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'stylist'",
];

let done = null;

export function ensureSchema() {
  if (!done) {
    done = (async () => {
      for (const sql of STATEMENTS) {
        try {
          await query(sql);
        } catch (err) {
          console.error('ensureSchema: left for db:migrate:', sql.split('\n')[0], err.message);
        }
      }
    })();
  }
  return done;
}
