-- A copy of each lunch and block in the stylist's Google Calendar
-- (asked for 2026-10-31: the connected calendar should show the time the
-- app has blocked, not only the bookings).
--
-- Keyed by the block and the person it was copied to, as google_events is
-- for appointments. The rows cascade away with the block, so the app reads
-- them and deletes the Google copies first (diary.js).
--
-- Additive, and in ensure-schema too.
CREATE TABLE IF NOT EXISTS google_blocks (
  time_off_id   int  NOT NULL REFERENCES time_off(id) ON DELETE CASCADE,
  staff_user_id uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  event_id      text NOT NULL,
  calendar_id   text NOT NULL DEFAULT 'primary',
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (time_off_id, staff_user_id)
);
