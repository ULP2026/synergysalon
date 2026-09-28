-- Staff console: account approval, contacts, and appointment outcomes.
--
-- Run once against an existing database. schema.sql carries the same shape for
-- a fresh one.

-- ------------------------------------------------- accounts need approving

-- Anyone can ask for an account from the login page. Nobody gets one until an
-- owner or manager says so: the console holds a salon's entire client list,
-- so self-service sign-up without a gate would be an open door.
CREATE TYPE staff_status AS ENUM ('pending', 'active', 'disabled');

ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS status staff_status NOT NULL DEFAULT 'active';
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS requested_at timestamptz;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS staff_users_pending ON staff_users (tenant_id, requested_at)
  WHERE status = 'pending';

-- ------------------------------------------------------ leads are contacts

-- One list of everyone: people who have booked and people who have only
-- enquired. Two lists means the same person ends up in both and somebody has
-- to merge them by hand.
ALTER TABLE leads RENAME TO contacts;
ALTER TYPE lead_status RENAME TO contact_status;
ALTER TABLE appointments RENAME COLUMN lead_id TO contact_id;
ALTER TABLE sync_outbox RENAME COLUMN lead_id TO contact_id;

ALTER INDEX leads_worklist RENAME TO contacts_worklist;
ALTER INDEX leads_email RENAME TO contacts_email;
ALTER INDEX leads_phone RENAME TO contacts_phone;

-- Cheap to read, and the difference between "a lead" and "a client".
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS first_booked_at timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_visit_at timestamptz;

-- --------------------------------------------- what happened at the chair

ALTER TYPE appointment_status ADD VALUE IF NOT EXISTS 'completed';
ALTER TYPE appointment_status ADD VALUE IF NOT EXISTS 'no_show';

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS checked_in_at timestamptz;

-- The no-overlap rule previously applied only to 'booked'. With completed and
-- no-show now possible, that would let a finished appointment's slot be sold
-- again underneath it. Only cancelling should give a slot back.
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_no_overlap;
ALTER TABLE appointments
  ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (stylist_id WITH =, during WITH &&)
  WHERE (status <> 'cancelled');
