/**
 * The columns the staff console's profile features write to, added if they
 * are missing.
 *
 * Migrations 010 to 013 and 016 to 026 were shipped with "run npm run db:migrate" and the
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
  // 027: the clean-down after an appointment stops reserving time. What the
  // rule compares is the guest's own time with the breaks cut out, which is
  // what the diary draws and what availability.js offers. Matched on the
  // constraint's text rather than its name, because the name is kept: an
  // older instance's cold start then leaves it alone instead of adding the
  // rule this replaces back beside it.
  `CREATE OR REPLACE FUNCTION appointment_blocks(starts timestamptz, minutes integer, breaks jsonb)
   RETURNS tstzmultirange LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
     SELECT tstzmultirange(tstzrange(starts, starts + make_interval(mins => minutes), '[)'))
            - COALESCE((SELECT range_agg(tstzrange(starts + make_interval(mins => (b->>0)::int),
                                                  starts + make_interval(mins => (b->>0)::int + (b->>1)::int), '[)'))
                          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(breaks) = 'array' THEN breaks ELSE '[]'::jsonb END) b),
                       '{}'::tstzmultirange)
   $$`,
  `DO $$ BEGIN
     PERFORM set_config('search_path', 'public, extensions', true);
     IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conname = 'appointments_no_overlap_blocks'
                       AND conrelid = 'appointments'::regclass
                       AND pg_get_constraintdef(oid) LIKE '%duration_min%') THEN
       ALTER TABLE appointments
         DROP CONSTRAINT IF EXISTS appointments_no_overlap_blocks,
         DROP CONSTRAINT IF EXISTS appointments_no_overlap,
         ADD CONSTRAINT appointments_no_overlap_blocks
         EXCLUDE USING gist (stylist_id WITH =, appointment_blocks(starts_at, duration_min, breaks) WITH &&)
         WHERE (status <> 'cancelled');
     END IF;
   END $$`,
  // 024: the send log and the automation switches, behind Marketing's count
  // and its toggles. Both degrade to "nothing sent, everything on" when they
  // are missing, so this only decides whether the numbers are real.
  `CREATE TABLE IF NOT EXISTS message_sends (
     id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
     kind           text NOT NULL,
     appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
     to_name        text,
     to_email       text NOT NULL,
     sent_at        timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS message_sends_tenant_kind
     ON message_sends (tenant_id, kind, sent_at DESC)`,
  "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS automations_off text[] NOT NULL DEFAULT '{}'",
  // 026: the follow-up queue behind M4 to M11. Without it every enqueue is a
  // logged warning and no follow-up is ever sent -- the bookings themselves
  // are unaffected, which is why it is safe to leave to this.
  `CREATE TABLE IF NOT EXISTS scheduled_messages (
     id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
     kind           text NOT NULL,
     appointment_id uuid REFERENCES appointments(id) ON DELETE CASCADE,
     contact_id     uuid REFERENCES contacts(id) ON DELETE CASCADE,
     to_name        text,
     to_email       text NOT NULL,
     send_after     timestamptz NOT NULL,
     sent_at        timestamptz,
     cancelled_at   timestamptz,
     cancel_reason  text,
     created_at     timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS scheduled_messages_due
     ON scheduled_messages (tenant_id, send_after)
     WHERE sent_at IS NULL AND cancelled_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS scheduled_messages_contact
     ON scheduled_messages (contact_id)
     WHERE sent_at IS NULL AND cancelled_at IS NULL`,
  // The index that makes a trigger running twice queue one message, not two.
  `CREATE UNIQUE INDEX IF NOT EXISTS scheduled_messages_once
     ON scheduled_messages (appointment_id, kind)
     WHERE appointment_id IS NOT NULL AND cancelled_at IS NULL`,
  'ALTER TABLE services ADD COLUMN IF NOT EXISTS rebook_days integer',
  'ALTER TABLE tenants ADD COLUMN IF NOT EXISTS review_url text',
  // 031, approved by the salon on 2026-10-31 so that a visit of several
  // services is shown whole everywhere: the itemized services of each
  // booking, and each client's email and text preferences. Additive; the
  // two preferences default to yes, which is what happens today.
  'ALTER TABLE appointments ADD COLUMN IF NOT EXISTS services jsonb',
  'ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_ok boolean NOT NULL DEFAULT true',
  'ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sms_ok boolean NOT NULL DEFAULT true',
  // 032: whether the salon holds a card for a client, set on their profile.
  // Additive, defaulting to no.
  'ALTER TABLE contacts ADD COLUMN IF NOT EXISTS card_on_file boolean NOT NULL DEFAULT false',
  // 033: Karen by text: her number, and where each conversation has got to.
  // Additive: a column nobody reads until it is set, and a table of its own.
  'ALTER TABLE tenants ADD COLUMN IF NOT EXISTS karen_phone text',
  `CREATE TABLE IF NOT EXISTS karen_threads (
     tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
     phone      text NOT NULL,
     state      jsonb NOT NULL DEFAULT '{}'::jsonb,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (tenant_id, phone))`,
  // 034: texting consent on the record, which is what decides whether an
  // appointment text goes out. Additive and empty until somebody opts in.
  'ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sms_consent_at timestamptz',
  'ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sms_consent_source text',
  'ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sms_consent_phone text',
  // 037: the email log complete enough for a client's Activity: subject,
  // sent or failed (and why), and the client. Older rows get their client
  // from their appointment.
  'ALTER TABLE message_sends ADD COLUMN IF NOT EXISTS subject text',
  "ALTER TABLE message_sends ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'sent'",
  'ALTER TABLE message_sends ADD COLUMN IF NOT EXISTS error text',
  'ALTER TABLE message_sends ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL',
  'CREATE INDEX IF NOT EXISTS message_sends_contact ON message_sends (contact_id, sent_at DESC)',
  `UPDATE message_sends m SET contact_id = a.contact_id
     FROM appointments a
    WHERE a.id = m.appointment_id AND m.contact_id IS NULL AND a.contact_id IS NOT NULL`,
  // 036: who booked it when it was not a person ('karen'), and her text
  // bookings from before, which carry her note.
  'ALTER TABLE appointments ADD COLUMN IF NOT EXISTS booked_via text',
  `UPDATE appointments SET booked_via = 'karen'
    WHERE booked_via IS NULL AND notes = 'Booked by text with Karen.'`,
  // 035: the Google copy of each lunch and block, so a stylist's calendar
  // shows the time the app has blocked. Additive and empty until used.
  `CREATE TABLE IF NOT EXISTS google_blocks (
     time_off_id   int  NOT NULL REFERENCES time_off(id) ON DELETE CASCADE,
     staff_user_id uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
     event_id      text NOT NULL,
     calendar_id   text NOT NULL DEFAULT 'primary',
     created_at    timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (time_off_id, staff_user_id))`,
  // And the people removed before the column existed. Each salon's stylists
  // who were never given a login are named in config.js; any other
  // switched-off row with no login is somebody who was removed. Harmless to
  // repeat: from now on a removal sets removed_at itself.
  ...Object.entries(GOOGLE_OPTIONAL_STYLISTS).map(([tenantSlug, slugs]) => `
    UPDATE stylists SET removed_at = now()
     WHERE removed_at IS NULL AND staff_user_id IS NULL AND NOT active
       AND tenant_id IN (SELECT id FROM tenants WHERE slug = '${tenantSlug}')
       AND slug <> ALL (ARRAY[${slugs.map((x) => `'${x}'`).join(', ')}]::text[])`),
  // 038: Karen's message history, every message with the team in the app
  // or by text, for the owner's Message History. A table of its own.
  `CREATE TABLE IF NOT EXISTS karen_messages (
     id         bigserial PRIMARY KEY,
     tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
     user_id    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
     who_name   text,
     channel    text NOT NULL CHECK (channel IN ('app', 'text')),
     role       text NOT NULL CHECK (role IN ('user', 'karen')),
     body       text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS karen_messages_by_person
     ON karen_messages (tenant_id, user_id, created_at DESC)`,
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
