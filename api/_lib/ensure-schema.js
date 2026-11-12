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
  // 039: messaging a client from their profile. A typed email's words, and
  // every text with a client, either way. Additive.
  'ALTER TABLE message_sends ADD COLUMN IF NOT EXISTS body text',
  `CREATE TABLE IF NOT EXISTS client_texts (
     id         bigserial PRIMARY KEY,
     tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
     contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
     direction  text NOT NULL CHECK (direction IN ('out', 'in')),
     kind       text NOT NULL,
     phone      text,
     body       text NOT NULL,
     sent_by    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
     status     text NOT NULL DEFAULT 'sent',
     error      text,
     created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS client_texts_by_client
     ON client_texts (tenant_id, contact_id, created_at DESC)`,
  // 040: Karen's Call History. A table of its own. Additive.
  `CREATE TABLE IF NOT EXISTS karen_calls (
     id           bigserial PRIMARY KEY,
     tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
     call_sid     text,
     from_phone   text,
     caller_kind  text,
     staff_id     uuid REFERENCES staff_users(id) ON DELETE SET NULL,
     contact_id   uuid REFERENCES contacts(id) ON DELETE SET NULL,
     caller_name  text,
     forwarded_to text,
     dial_status  text,
     duration_sec int,
     created_at   timestamptz NOT NULL DEFAULT now(),
     updated_at   timestamptz NOT NULL DEFAULT now())`,
  'CREATE UNIQUE INDEX IF NOT EXISTS karen_calls_sid ON karen_calls (call_sid) WHERE call_sid IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS karen_calls_by_salon ON karen_calls (tenant_id, created_at DESC)',
  // 041: a client's tags, and the Admin history of changes to their record.
  // A column with a default and a table of its own. Additive.
  "ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}'",
  `CREATE TABLE IF NOT EXISTS contact_changes (
     id          bigserial PRIMARY KEY,
     tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
     contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
     changed_by  uuid REFERENCES staff_users(id) ON DELETE SET NULL,
     who_name    text,
     field       text NOT NULL,
     old_value   text,
     new_value   text,
     created_at  timestamptz NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS contact_changes_by_client ON contact_changes (tenant_id, contact_id, created_at DESC)',
  // 042: onboarding. Added with now() so everyone already on the team counts
  // as done, then the default dropped so anyone added later starts at NULL.
  // Run again, the ADD finds the column and fills nothing.
  'ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS onboarded_at timestamptz DEFAULT now()',
  'ALTER TABLE staff_users ALTER COLUMN onboarded_at DROP DEFAULT',
  // 043: a team member's job title, asked at onboarding. Additive.
  'ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS job_title text',
  // 044: the onboarding step somebody stopped at. Additive.
  'ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS onboarding_step text',
  // 045: a service of one stylist's own, offered only with them. Additive.
  'ALTER TABLE services ADD COLUMN IF NOT EXISTS owner_staff_id uuid',
  'CREATE INDEX IF NOT EXISTS services_by_owner ON services (tenant_id, owner_staff_id) WHERE owner_staff_id IS NOT NULL',
  // 046: the texts Karen sends the team (the invitation welcome), kept for
  // Sent History. A table of its own; additive.
  `CREATE TABLE IF NOT EXISTS team_texts (
     id            bigserial PRIMARY KEY,
     tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
     staff_user_id uuid REFERENCES staff_users(id) ON DELETE SET NULL,
     kind          text NOT NULL,
     to_name       text,
     phone         text,
     body          text NOT NULL,
     status        text NOT NULL DEFAULT 'sent',
     error         text,
     created_at    timestamptz NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS team_texts_by_kind ON team_texts (tenant_id, kind, created_at DESC)',
  // 047: the used invite link, kept until setup is finished, to resume it.
  'ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS setup_hash text',
  // 049: why a connected Google account cannot be read (no_calendar).
  'ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS google_problem text',
  // 048: a stylist's own automation switches, and cash-out requests.
  "ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS automations_off text[] NOT NULL DEFAULT '{}'",
  `CREATE TABLE IF NOT EXISTS cashout_requests (
     id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
     staff_user_id uuid REFERENCES staff_users(id) ON DELETE SET NULL,
     staff_name    text NOT NULL,
     amount_cents  int NOT NULL CHECK (amount_cents > 0),
     note          text,
     status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'paid', 'declined')),
     decided_by    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
     decided_at    timestamptz,
     created_at    timestamptz NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS cashout_requests_by_salon ON cashout_requests (tenant_id, created_at DESC)',
  // 050: payroll through Stripe Connect: the stylist's connected account,
  // and a cash out's transfer, its reason when it failed, and the two new
  // states. The check is swapped only while it lacks 'processing', so a warm
  // start does not take the table's lock every time.
  'ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS stripe_account_id text',
  'ALTER TABLE cashout_requests ADD COLUMN IF NOT EXISTS stripe_transfer_id text',
  'ALTER TABLE cashout_requests ADD COLUMN IF NOT EXISTS error text',
  // 051: the generic "Haircut" off the menu; Cuts is Women's, Men's, Teen,
  // Kids' and the Bang Trim, as the website's survey has it.
  "UPDATE services SET active = false WHERE slug = 'haircuts' AND active",
  // 052: the service menu of 2026-11-05 (Bond Repair named K18/Olaplex
  // Treatment since 2026-11-06, 054: this line renamed it on every cold
  // start, so it carries the new name). (Teen Cut, Highlights & Foils, Color
  // & Cut and Bridal off; Partial and Full Highlights, Condition and Mask
  // Treatment in; Updos and Consultation renamed). Idempotent: the updates
  // match nothing the second time and the inserts skip existing slugs.
  `UPDATE services SET active = false
 WHERE owner_staff_id IS NULL AND active
   AND slug IN ('teen-cut', 'highlights-and-foils', 'color-and-cut', 'bridal-styling')`,
  `UPDATE services SET name = 'K18/Olaplex Treatment', blurb = 'Rebuild what damage broke'
 WHERE owner_staff_id IS NULL AND slug = 'bond-repair'`,
  `UPDATE services SET name = 'Updos', blurb = 'Weddings, bridal parties, prom and special events'
 WHERE owner_staff_id IS NULL AND slug = 'special-event'`,
  `UPDATE services SET name = 'Consultation', blurb = 'Talk it through with your stylist first', consult_first = true
 WHERE owner_staff_id IS NULL AND slug = 'extensions'`,
  `INSERT INTO services (tenant_id, slug, name, category, blurb, duration_min, buffer_min, price_cents, consult_first, sort_order)
SELECT t.id, v.*
FROM tenants t, (VALUES
  ('partial-highlights',  'Partial Highlights',  'color',      'Face-framing and crown',          120, 15, NULL::integer, false, 18),
  ('full-highlights',     'Full Highlights',     'color',      'All over, root to end',           150, 15, NULL,          false, 19),
  ('condition-treatment', 'Condition Treatment', 'treatments', 'Deep conditioning, soft and healthy', 30, 10, NULL,      false, 52),
  ('mask-treatment',      'Mask Treatment',      'treatments', 'A nourishing hair mask',           30, 10, NULL,          false, 54)
) AS v(slug, name, category, blurb, duration_min, buffer_min, price_cents, consult_first, sort_order)
WHERE t.slug = 'synergy'
ON CONFLICT (tenant_id, slug) DO NOTHING`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conname = 'cashout_requests_status_check'
                       AND pg_get_constraintdef(oid) LIKE '%processing%') THEN
       ALTER TABLE cashout_requests DROP CONSTRAINT IF EXISTS cashout_requests_status_check;
       ALTER TABLE cashout_requests ADD CONSTRAINT cashout_requests_status_check
         CHECK (status IN ('requested', 'processing', 'paid', 'failed', 'declined'));
     END IF;
   END $$`,
  `INSERT INTO stylist_services (stylist_id, service_id)
SELECT DISTINCT ss.stylist_id, v.id
  FROM stylist_services ss
  JOIN services o ON o.id = ss.service_id
  JOIN services v ON v.tenant_id = o.tenant_id AND v.category = o.category
 WHERE v.slug IN ('partial-highlights', 'full-highlights', 'condition-treatment', 'mask-treatment')
   AND v.owner_staff_id IS NULL AND o.owner_staff_id IS NULL
   -- once only: a service already linked to anybody is left to roster.js,
   -- so a stylist who unticks one is not given it back on the next start
   AND NOT EXISTS (SELECT 1 FROM stylist_services z WHERE z.service_id = v.id)
ON CONFLICT DO NOTHING`,
  // 053: Shampoo Blowout under Styling (2026-11-06); idempotent, and the
  // stylists' link is made once only.
  `INSERT INTO services (tenant_id, slug, name, category, blurb, duration_min, buffer_min, price_cents, consult_first, sort_order)
SELECT t.id, 'shampoo-blowout', 'Shampoo Blowout', 'styling', 'Wash, blow-dry and style', 45, 10, NULL, false, 85
  FROM tenants t
 WHERE t.slug = 'synergy'
ON CONFLICT (tenant_id, slug) DO NOTHING`,
  `INSERT INTO stylist_services (stylist_id, service_id)
SELECT DISTINCT ss.stylist_id, v.id
  FROM stylist_services ss
  JOIN services o ON o.id = ss.service_id
  JOIN services v ON v.tenant_id = o.tenant_id AND v.category = o.category
 WHERE v.slug = 'shampoo-blowout'
   AND v.owner_staff_id IS NULL AND o.owner_staff_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM stylist_services z WHERE z.service_id = v.id)
ON CONFLICT DO NOTHING`,
  // 058: Perm under Treatments (2026-11-09); idempotent, and the stylists'
  // link is made once only, as for 053.
  `INSERT INTO services (tenant_id, slug, name, category, blurb, duration_min, buffer_min, price_cents, consult_first, sort_order)
SELECT t.id, 'perm', 'Perm', 'treatments', 'Lasting curl, wave and body', 120, 15, NULL, false, 56
  FROM tenants t
 WHERE t.slug = 'synergy'
ON CONFLICT (tenant_id, slug) DO NOTHING`,
  `INSERT INTO stylist_services (stylist_id, service_id)
SELECT DISTINCT ss.stylist_id, v.id
  FROM stylist_services ss
  JOIN services o ON o.id = ss.service_id
  JOIN services v ON v.tenant_id = o.tenant_id AND v.category = o.category
 WHERE v.slug = 'perm'
   AND v.owner_staff_id IS NULL AND o.owner_staff_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM stylist_services z WHERE z.service_id = v.id)
ON CONFLICT DO NOTHING`,
  // 055: the salon's Hours of Operation (hours.js).
  'ALTER TABLE tenants ADD COLUMN IF NOT EXISTS hours jsonb',
  // 056: Forgot Password? (reset.js).
  'ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS reset_hash text',
  'ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS reset_expires_at timestamptz',
  'ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS reset_requested_at timestamptz',
  'CREATE INDEX IF NOT EXISTS staff_users_reset_hash ON staff_users (reset_hash) WHERE reset_hash IS NOT NULL',
  // 057: Karen answers the salon's email (karen-email.js).
  `CREATE TABLE IF NOT EXISTS email_threads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  counterpart_email text NOT NULL,
  counterpart_name  text NOT NULL DEFAULT '',
  subject           text NOT NULL DEFAULT '',
  contact_id        uuid REFERENCES contacts(id) ON DELETE SET NULL,
  staff_user_id     uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'open',
  last_at           timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
)`,
  `CREATE INDEX IF NOT EXISTS email_threads_recent ON email_threads (tenant_id, last_at DESC)`,
  `CREATE INDEX IF NOT EXISTS email_threads_who ON email_threads (tenant_id, lower(counterpart_email))`,
  `CREATE TABLE IF NOT EXISTS email_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  thread_id    uuid NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE,
  direction    text NOT NULL CHECK (direction IN ('in', 'out')),
  message_id   text,
  provider_id  text,
  in_reply_to  text,
  refs         text NOT NULL DEFAULT '',
  from_email   text NOT NULL,
  from_name    text NOT NULL DEFAULT '',
  to_email     text NOT NULL DEFAULT '',
  subject      text NOT NULL DEFAULT '',
  body         text NOT NULL DEFAULT '',
  status       text NOT NULL,
  note         text NOT NULL DEFAULT '',
  answers      uuid REFERENCES email_messages(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS email_messages_msgid ON email_messages (tenant_id, message_id) WHERE message_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS email_messages_received ON email_messages (provider_id) WHERE provider_id IS NOT NULL AND direction = 'in'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS email_messages_one_answer ON email_messages (answers) WHERE answers IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS email_messages_thread ON email_messages (thread_id, created_at)`,
  `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS karen_email_on boolean NOT NULL DEFAULT true`,
  // 061: the salon's own Stripe, linked by "Connect with Stripe".
  `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_account_id text`,
  `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_livemode boolean`,
  `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_connected_at timestamptz`,
  `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_connected_by uuid`,
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
