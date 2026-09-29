-- A real Google connection, per person.
--
-- The subscribe link stays for Apple and Outlook, but it is one-way and
-- read-only: it can show a stylist their day, and can never put an
-- appointment into the calendar they actually live in. This is the other
-- direction.
--
-- The refresh token is the sensitive one -- it does not expire, and it is
-- enough on its own to read and write somebody's calendar until they revoke
-- it. It is stored encrypted (AES-256-GCM, key in the environment) so that a
-- copy of the database is not a copy of the team's Google accounts.
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS google_email         text;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS google_refresh_token text;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS google_access_token  text;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS google_expires_at    timestamptz;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS google_calendar_id   text;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS google_connected_at  timestamptz;

-- Which Google event an appointment became, for the person it was pushed to.
-- Keyed by both, because two stylists could each have their own copy.
CREATE TABLE IF NOT EXISTS google_events (
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  staff_user_id  uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  event_id       text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (appointment_id, staff_user_id)
);
