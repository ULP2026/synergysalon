-- Calendars a shop creates for itself.
--
-- Until now there was one implicit calendar: the salon's diary, with every
-- stylist in it. That is the right default and the wrong ceiling. A shop wants
-- "Colour consultations with Dina", "Any stylist, 30 minutes", "Saturday
-- bridal trials" -- each with its own name, its own link, its own length.
--
-- A calendar is a way of being booked, not a second diary. Appointments still
-- live in one table and the exclusion constraint still prevents double-booking
-- across all of them: two calendars pointing at the same stylist cannot both
-- sell the same hour.
CREATE TABLE IF NOT EXISTS booking_calendars (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  name        text NOT NULL,
  -- The last part of the booking link. Unique per shop, not globally: two
  -- salons may both have a "haircut" calendar.
  slug        text NOT NULL,
  description text NOT NULL DEFAULT '',

  -- How this calendar allocates people. The names follow the ones every CRM
  -- uses, so a shop moving from one recognises them.
  --   personal   one named person
  --   round_robin spread across several, in turn
  --   class      one host, many guests in the same slot
  --   collective several people, all required, one guest
  --   event      a fixture with no host
  --   service    a service a shop sells, whoever is free
  kind        text NOT NULL DEFAULT 'service'
              CHECK (kind IN ('personal','round_robin','class','collective','event','service')),

  duration_min integer NOT NULL DEFAULT 30 CHECK (duration_min BETWEEN 5 AND 600),
  -- Clean-down after the guest leaves. Blocks the diary; not sold to anyone.
  buffer_min   integer NOT NULL DEFAULT 0 CHECK (buffer_min BETWEEN 0 AND 240),

  -- A class is the only kind where more than one guest shares a slot.
  capacity     integer NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 200),

  accept_payments boolean NOT NULL DEFAULT false,
  active          boolean NOT NULL DEFAULT true,

  -- Everything the Advanced settings page writes: notice period, how far
  -- ahead people may book, confirmation wording, and whatever is added next.
  -- A column per option would be a migration per option.
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, slug)
);

-- Who can be booked through a calendar. Several for round robin and
-- collective, one for personal, none for an event.
CREATE TABLE IF NOT EXISTS booking_calendar_members (
  calendar_id uuid NOT NULL REFERENCES booking_calendars(id) ON DELETE CASCADE,
  stylist_id  uuid NOT NULL REFERENCES stylists(id) ON DELETE CASCADE,
  sort_order  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (calendar_id, stylist_id)
);

CREATE INDEX IF NOT EXISTS booking_calendars_tenant
  ON booking_calendars (tenant_id, active, name);

-- Which calendar an appointment came through, when it came through one.
-- Nullable: every appointment taken before this existed came through none,
-- and the console's own "New appointment" still does.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS calendar_id uuid REFERENCES booking_calendars(id) ON DELETE SET NULL;
