-- A team member's Google Calendar by its private iCal address.
--
-- Signing in with Google needs an OAuth client the site does not have yet,
-- so Connect your tools had nothing anybody could fill in. The "Secret
-- address in iCal format" every Google Calendar has needs no setup on our
-- side. Encrypted when TOKEN_KEY is set: the address alone reads the calendar.
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS google_ics text;
