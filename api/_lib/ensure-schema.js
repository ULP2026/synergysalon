/**
 * The columns the staff console's profile features write to, added if they
 * are missing.
 *
 * Migrations 010 to 013 and 016 to 025 were shipped with "run npm run db:migrate" and the
 * console went live before anyone did, so every save of a username, price
 * or avatar choice failed in production. These are the same statements, all
 * idempotent (IF NOT EXISTS), run once per warm function. db:migrate still
 * records the migrations when it is run; running them again is harmless.
 * Anything that fails is logged and left for db:migrate, never thrown: the
 * console must load whatever state the database is in.
 */
import { query } from './db.js';
import { GOOGLE_OPTIONAL_STYLISTS } from './config.js';

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
  // 021: Admin as a role, the owner's rights over the team without the title.
  "ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'admin'",
  // 017: the inbox guests' replies go to, set in Team Settings.
  'ALTER TABLE tenants ADD COLUMN IF NOT EXISTS reply_to text',
  // 018: a Google Calendar by its private iCal address (google-ics.js).
  'ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS google_ics text',
  // 019: the Home dashboard's layout, set by the admin from Customize.
  'ALTER TABLE tenants ADD COLUMN IF NOT EXISTS home_layout jsonb',
  // 020: which Google calendar each booking copy is in (the salon's own, or
  // the main one for copies made before it existed).
  "ALTER TABLE google_events ADD COLUMN IF NOT EXISTS calendar_id text NOT NULL DEFAULT 'primary'",
  // 022: a removed team member's stylist row is history, not a member, so it
  // stops reappearing on the Team list as a stylist without a sign-in.
  'ALTER TABLE stylists ADD COLUMN IF NOT EXISTS removed_at timestamptz',
  // 023: prices, lengths and notes for a stylist without a sign-in, who has
  // no staff_users.services to keep them in.
  "ALTER TABLE stylists ADD COLUMN IF NOT EXISTS service_details jsonb NOT NULL DEFAULT '{}'::jsonb",
  // 025: processing breaks. A color appointment's Break frees its stylist, so
  // the no-overlap rule compares only the parts they are working. The new
  // constraint is added before the old one is dropped, so there is never a
  // moment without one, and it is built once, not on every cold start.
  "ALTER TABLE appointments ADD COLUMN IF NOT EXISTS breaks jsonb NOT NULL DEFAULT '[]'::jsonb",
  `CREATE OR REPLACE FUNCTION appointment_blocks(starts timestamptz, ends timestamptz, breaks jsonb)
   RETURNS tstzmultirange LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
     SELECT tstzmultirange(tstzrange(starts, ends, '[)'))
            - COALESCE((SELECT range_agg(tstzrange(starts + make_interval(mins => (b->>0)::int),
                                                  starts + make_interval(mins => (b->>0)::int + (b->>1)::int), '[)'))
                          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(breaks) = 'array' THEN breaks ELSE '[]'::jsonb END) b),
                       '{}'::tstzmultirange)
   $$`,
  `DO $$ BEGIN
     PERFORM set_config('search_path', 'public, extensions', true);
     IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conname = 'appointments_no_overlap_blocks'
                       AND conrelid = 'appointments'::regclass) THEN
       ALTER TABLE appointments ADD CONSTRAINT appointments_no_overlap_blocks
         EXCLUDE USING gist (stylist_id WITH =, appointment_blocks(starts_at, upper(during), breaks) WITH &&)
         WHERE (status <> 'cancelled');
     END IF;
     ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_no_overlap;
   END $$`,
  // And the people removed before the column existed. Each salon's stylists
  // who were never given a login are named in config.js; any other
  // switched-off row with no login is somebody who was removed. Harmless to
  // repeat: from now on a removal sets removed_at itself.
  ...Object.entries(GOOGLE_OPTIONAL_STYLISTS).map(([tenantSlug, slugs]) => `
    UPDATE stylists SET removed_at = now()
     WHERE removed_at IS NULL AND staff_user_id IS NULL AND NOT active
       AND tenant_id IN (SELECT id FROM tenants WHERE slug = '${tenantSlug}')
       AND slug <> ALL (ARRAY[${slugs.map((x) => `'${x}'`).join(', ')}]::text[])`),
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
