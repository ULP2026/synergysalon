-- Booking system schema.
--
-- Three things in here are load-bearing and worth reading before changing:
--
--   1. The exclusion constraint on appointments. Double-booking is prevented
--      by Postgres refusing overlapping ranges, not by checking availability
--      before inserting, because two requests can both read "free" before
--      either one writes.
--
--   2. tenant_id everywhere. One salon is the first customer, not the only
--      one. Retrofitting this later means touching every table and query, so
--      it is here from the start even while there is a single row in tenants.
--
--   3. sync_outbox. Pushing to GoHighLevel happens after the booking is
--      committed, never during it. A CRM outage must not cost the salon an
--      appointment.

SET search_path = public, extensions;

-- Supabase keeps extensions in an "extensions" schema. If btree_gist is
-- already installed there, this is a no-op and the gist operator class stays
-- off the search path, so the exclusion constraint below fails to create --
-- silently leaving the system with no double-booking protection at all. The
-- search_path above covers that case, and a schema that does not exist is
-- ignored on a plain Postgres.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- gen_random_uuid() has been core Postgres since 13, so no pgcrypto needed.

-- ----------------------------------------------------------------- tenants

CREATE TABLE tenants (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug      text NOT NULL UNIQUE,            -- 'synergy'
  name      text NOT NULL,
  -- Slots are generated on this clock. Two salons in different states must
  -- not share one, which is the other reason tenancy cannot be bolted on.
  timezone  text NOT NULL DEFAULT 'America/New_York',
  -- The public site this tenant answers for, used to resolve which salon a
  -- guest is booking with.
  host      text UNIQUE,
  -- Where this salon's team signs in. A separate host rather than a path so
  -- the console can be locked down, branded and linked independently of the
  -- marketing site -- and so each tenant gets its own front door.
  app_host  text UNIQUE,

  -- CENTRO / GoHighLevel. The token is a private integration token scoped to
  -- this sub-account. It is never returned by any endpoint.
  ghl_location_id text,
  ghl_token       text,
  ghl_calendar_id text,

  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------- staff auth

CREATE TYPE staff_role AS ENUM ('owner', 'manager', 'front_desk');

CREATE TABLE staff_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         text NOT NULL,
  -- scrypt, salt and parameters encoded in the string. See _lib/password.js.
  password_hash text NOT NULL,
  name          text NOT NULL,
  role          staff_role NOT NULL DEFAULT 'front_desk',
  active        boolean NOT NULL DEFAULT true,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- Brute-force protection. Kept on the row rather than in memory because
  -- serverless functions do not share memory: an in-process counter resets
  -- every cold start, which is to say it protects nothing.
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until    timestamptz
);

-- Two salons may each employ a Kim with the same personal email address.
CREATE UNIQUE INDEX staff_users_email ON staff_users (tenant_id, lower(email));

CREATE TABLE staff_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  -- The cookie holds the token; only its hash is stored, so a leaked database
  -- backup cannot be used to sign in as anybody.
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent   text NOT NULL DEFAULT ''
);

CREATE INDEX staff_sessions_expiry ON staff_sessions (expires_at);

-- ---------------------------------------------------------------- services

CREATE TABLE services (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug          text NOT NULL,               -- matches the #anchor on the service pages
  name          text NOT NULL,
  category      text NOT NULL,
  blurb         text NOT NULL DEFAULT '',
  -- How long the guest is in the chair. Drives every availability
  -- calculation, so a wrong number here sells a slot that cannot be honoured.
  duration_min  integer NOT NULL CHECK (duration_min > 0),
  -- Clean-down after the guest leaves. Blocks the diary, never shown as part
  -- of the appointment.
  buffer_min    integer NOT NULL DEFAULT 15 CHECK (buffer_min >= 0),
  -- NULL means no published price. Wrong prices are worse than none, so the
  -- front end says "priced at consultation" rather than inventing one.
  price_cents   integer CHECK (price_cents IS NULL OR price_cents >= 0),
  consult_first boolean NOT NULL DEFAULT false,
  active        boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, slug)
);

-- ---------------------------------------------------------------- stylists

CREATE TABLE stylists (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug       text NOT NULL,
  name       text NOT NULL,
  title      text NOT NULL DEFAULT '',
  -- Set when this stylist is also a login, so her diary can be shown to her.
  staff_user_id uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  active     boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, slug)
);

CREATE TABLE stylist_services (
  stylist_id uuid NOT NULL REFERENCES stylists(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (stylist_id, service_id)
);

-- Recurring weekly hours, held as local wall-clock times rather than instants
-- so they survive daylight saving: 09:00 stays 09:00 in March and November.
CREATE TABLE stylist_hours (
  id         serial PRIMARY KEY,
  stylist_id uuid NOT NULL REFERENCES stylists(id) ON DELETE CASCADE,
  weekday    smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),   -- 0 = Sunday
  starts_at  time NOT NULL,
  ends_at    time NOT NULL,
  CHECK (ends_at > starts_at)
);

CREATE INDEX stylist_hours_lookup ON stylist_hours (stylist_id, weekday);

-- Holidays, sick days, training, one-off closures.
-- A NULL stylist_id closes the whole salon.
CREATE TABLE time_off (
  id         serial PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stylist_id uuid REFERENCES stylists(id) ON DELETE CASCADE,
  during     tstzrange NOT NULL,
  reason     text NOT NULL DEFAULT ''
);

CREATE INDEX time_off_during ON time_off USING gist (during);

-- ------------------------------------------------------------------- leads

CREATE TYPE lead_status AS ENUM ('new', 'contacted', 'booked', 'won', 'lost');

-- Someone who has shown interest but is not yet in the chair: an ad enquiry,
-- a phone call, a walk-in asking about colour. The team works this list and
-- books from it, which is the whole point of the staff side.
CREATE TABLE leads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  email       text NOT NULL DEFAULT '',
  phone       text NOT NULL DEFAULT '',
  source      text NOT NULL DEFAULT '',      -- 'phone', 'walk-in', 'facebook-ad', 'website'
  status      lead_status NOT NULL DEFAULT 'new',
  notes       text NOT NULL DEFAULT '',
  assigned_to uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_by  uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  -- Filled in once this person exists in CENTRO, so we update rather than
  -- create a duplicate contact next time.
  ghl_contact_id text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (email <> '' OR phone <> '')
);

CREATE INDEX leads_worklist ON leads (tenant_id, status, created_at DESC);
CREATE INDEX leads_email ON leads (tenant_id, lower(email)) WHERE email <> '';
CREATE INDEX leads_phone ON leads (tenant_id, phone) WHERE phone <> '';

-- ------------------------------------------------------------ appointments

CREATE TYPE appointment_status AS ENUM ('booked', 'cancelled');
CREATE TYPE booking_channel AS ENUM ('online', 'staff');

CREATE TABLE appointments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- What the guest quotes on the phone. No O/0 or I/1: they are always
  -- misheard.
  ref        text NOT NULL UNIQUE,
  stylist_id uuid NOT NULL REFERENCES stylists(id),
  service_id uuid NOT NULL REFERENCES services(id),
  lead_id    uuid REFERENCES leads(id) ON DELETE SET NULL,

  starts_at    timestamptz NOT NULL,
  -- Snapshots, not lookups: re-timing a service next year must not silently
  -- move appointments already in the book.
  duration_min integer NOT NULL CHECK (duration_min > 0),
  buffer_min   integer NOT NULL DEFAULT 0 CHECK (buffer_min >= 0),
  price_cents  integer,
  -- starts_at to the end of the buffer. This is what the diary blocks and
  -- what the exclusion constraint compares. The guest's own end time is
  -- starts_at + duration_min.
  during       tstzrange NOT NULL,

  status  appointment_status NOT NULL DEFAULT 'booked',
  channel booking_channel NOT NULL DEFAULT 'online',
  -- Who took the booking, when a member of staff did.
  booked_by uuid REFERENCES staff_users(id) ON DELETE SET NULL,

  guest_name  text NOT NULL,
  guest_email text NOT NULL DEFAULT '',
  guest_phone text NOT NULL DEFAULT '',
  notes       text NOT NULL DEFAULT '',

  -- Lets a guest reschedule or cancel from the link in their confirmation
  -- email without an account. Random, single purpose, dead after cancelling.
  manage_token text NOT NULL UNIQUE,

  ghl_appointment_id text,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  cancelled_at     timestamptz,
  reminder_sent_at timestamptz,

  -- A staff booking may have only a phone number; an online one always has
  -- an email, because that is where the confirmation goes.
  CHECK (guest_email <> '' OR guest_phone <> ''),
  CHECK (channel = 'staff' OR guest_email <> ''),
  CHECK (during = tstzrange(starts_at,
                            starts_at + make_interval(mins => duration_min + buffer_min),
                            '[)'))
);

-- One stylist cannot be in two places at once. Live bookings only, so
-- cancelling genuinely frees the slot for the next guest.
--
-- stylist_id is globally unique, so this is tenant-safe without naming
-- tenant_id: two salons can never share a stylist row.
ALTER TABLE appointments
  ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (stylist_id WITH =, during WITH &&)
  WHERE (status = 'booked');

CREATE INDEX appointments_during   ON appointments USING gist (during) WHERE status = 'booked';
CREATE INDEX appointments_upcoming ON appointments (tenant_id, starts_at) WHERE status = 'booked';
CREATE INDEX appointments_guest    ON appointments (tenant_id, lower(guest_email));

-- ------------------------------------------------------------ CRM outbox

CREATE TYPE sync_state AS ENUM ('pending', 'done', 'failed');

-- Work waiting to be pushed to CENTRO.
--
-- Written in the same transaction as the booking it describes, processed
-- afterwards. That ordering is the point: if GoHighLevel is down, or its
-- token has expired, the appointment is still safely made and the push
-- retries later. Doing it inline would mean a CRM outage turns guests away.
CREATE TABLE sync_outbox (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        text NOT NULL,                 -- 'appointment.booked', 'lead.created', ...
  appointment_id uuid REFERENCES appointments(id) ON DELETE CASCADE,
  lead_id     uuid REFERENCES leads(id) ON DELETE CASCADE,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  state       sync_state NOT NULL DEFAULT 'pending',
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  -- Backs off after a failure instead of hammering a CRM that is struggling.
  next_try_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  done_at     timestamptz
);

CREATE INDEX sync_outbox_queue ON sync_outbox (next_try_at)
  WHERE state = 'pending';
