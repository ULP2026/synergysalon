-- Bookings copied to a stylist's Google account go into a calendar the app
-- creates for the salon, not their main one. Each copy remembers which
-- calendar it is in, so it is edited or removed there; copies made before
-- this are in the main calendar, which the default records.
-- staff_users.google_calendar_id (010) now holds that calendar's id, or
-- 'primary' for a connection that cannot create calendars.
ALTER TABLE google_events ADD COLUMN IF NOT EXISTS calendar_id text NOT NULL DEFAULT 'primary';
