-- Synergy Salon booking system.
--
-- The important line in this file is the exclusion constraint at the bottom.
-- Two people can click the same slot in the same millisecond; application code
-- that reads availability and then inserts cannot prevent that, because both
-- requests read before either writes. Postgres refusing to store overlapping
-- ranges for one stylist is the only version of this that is actually true.

-- Supabase keeps extensions in an "extensions" schema rather than public. If
-- btree_gist is already installed there, CREATE EXTENSION below is a no-op and
-- the gist operator class stays where the search path cannot see it, and the
-- exclusion constraint then fails with "no default operator class". Naming the
-- schema here covers that case and is harmless on a plain Postgres, where a
-- schema that does not exist is simply ignored.
SET search_path = public, extensions;

-- Lets one exclusion constraint mix = (on the stylist) with && (on the time).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- gen_random_uuid() is core Postgres from 13 onwards, so no pgcrypto here.

-- ---------------------------------------------------------------- services

CREATE TABLE services (
  id            text PRIMARY KEY,            -- 'balayage', matches the #anchor on the service pages
  name          text NOT NULL,
  category      text NOT NULL CHECK (category IN ('color', 'treatments', 'cuts', 'styling')),
  blurb         text NOT NULL DEFAULT '',
  -- How long the guest is in the chair. Drives every availability calculation,
  -- so a wrong number here shows slots that cannot be honoured.
  duration_min  integer NOT NULL CHECK (duration_min > 0),
  -- Clean-down and turnaround after the guest leaves. Blocks the diary but is
  -- never shown as part of the appointment.
  buffer_min    integer NOT NULL DEFAULT 15 CHECK (buffer_min >= 0),
  -- NULL means "no published price". The salon's price menu is still being
  -- rebuilt, and a wrong price is worse than no price, so the front end shows
  -- "priced at consultation" until this is filled in.
  price_cents   integer CHECK (price_cents IS NULL OR price_cents >= 0),
  -- Some services cannot be booked blind: the length, condition and history
  -- change both the time and the price.
  consult_first boolean NOT NULL DEFAULT false,
  active        boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------- stylists

CREATE TABLE stylists (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  title      text NOT NULL DEFAULT '',
  active     boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0
);

-- Not every stylist offers every service.
CREATE TABLE stylist_services (
  stylist_id text NOT NULL REFERENCES stylists(id) ON DELETE CASCADE,
  service_id text NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (stylist_id, service_id)
);

-- Recurring weekly hours, held as local wall-clock times rather than instants
-- so they survive daylight saving: 09:00 stays 09:00 in March and November.
CREATE TABLE stylist_hours (
  id         serial PRIMARY KEY,
  stylist_id text NOT NULL REFERENCES stylists(id) ON DELETE CASCADE,
  weekday    smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),   -- 0 = Sunday
  starts_at  time NOT NULL,
  ends_at    time NOT NULL,
  CHECK (ends_at > starts_at)
);

CREATE INDEX stylist_hours_lookup ON stylist_hours (stylist_id, weekday);

-- Holidays, sick days, training, and one-off salon closures.
-- A NULL stylist_id closes the whole salon.
CREATE TABLE time_off (
  id         serial PRIMARY KEY,
  stylist_id text REFERENCES stylists(id) ON DELETE CASCADE,
  during     tstzrange NOT NULL,
  reason     text NOT NULL DEFAULT ''
);

CREATE INDEX time_off_during ON time_off USING gist (during);

-- ------------------------------------------------------------ appointments

CREATE TYPE appointment_status AS ENUM ('booked', 'cancelled');

CREATE TABLE appointments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What the guest is told to quote on the phone. Short, unambiguous, no
  -- characters that survive being read aloud badly (no O/0, I/1).
  ref          text NOT NULL UNIQUE,
  stylist_id   text NOT NULL REFERENCES stylists(id),
  service_id   text NOT NULL REFERENCES services(id),

  starts_at    timestamptz NOT NULL,
  -- Snapshots, not lookups: re-timing a service next year must not silently
  -- move appointments already in the book.
  duration_min integer NOT NULL CHECK (duration_min > 0),
  buffer_min   integer NOT NULL DEFAULT 0 CHECK (buffer_min >= 0),
  price_cents  integer,
  -- starts_at .. end of buffer. This is what the diary blocks out, and what
  -- the exclusion constraint compares. The guest's own end time is
  -- starts_at + duration_min.
  during       tstzrange NOT NULL,

  status       appointment_status NOT NULL DEFAULT 'booked',

  guest_name   text NOT NULL,
  guest_email  text NOT NULL,
  guest_phone  text NOT NULL DEFAULT '',
  notes        text NOT NULL DEFAULT '',

  -- Lets a guest reschedule or cancel from the link in their confirmation
  -- email without an account. Random, single purpose, revoked on cancel.
  manage_token text NOT NULL UNIQUE,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  cancelled_at     timestamptz,
  reminder_sent_at timestamptz,

  CHECK (during = tstzrange(starts_at,
                            starts_at + make_interval(mins => duration_min + buffer_min),
                            '[)'))
);

-- One stylist cannot be in two places at once. Enforced for live bookings
-- only, so cancelling genuinely frees the slot for the next guest.
ALTER TABLE appointments
  ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (stylist_id WITH =, during WITH &&)
  WHERE (status = 'booked');

CREATE INDEX appointments_during   ON appointments USING gist (during) WHERE status = 'booked';
CREATE INDEX appointments_upcoming ON appointments (starts_at) WHERE status = 'booked';
CREATE INDEX appointments_guest    ON appointments (lower(guest_email));
