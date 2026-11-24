-- Which website survey session booked an appointment (2026-11-25). The survey
-- matches a guest to an existing client by email or phone, but a match by
-- email or phone alone is not proof it is the same person, so only the
-- session that made a booking may move it or be told its details
-- (api/enquiry.js). Bookings made at the desk, by Karen or before this
-- column have none, and the survey never moves them. Also in ensure-schema.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS booked_session_id text;
