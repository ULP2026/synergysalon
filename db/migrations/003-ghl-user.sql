-- CENTRO refuses an appointment without a team member: its calendars are
-- "service_booking" type, and every event must be assigned to a GoHighLevel
-- user. Our stylists are our own records and have no such id, so the mapping
-- has to be stored.
--
-- The tenant carries a default, taken from the calendar's own team member,
-- which is what the salon's CENTRO calendar has today: one person, everything
-- assigned to them. Per-stylist ids override it as soon as each stylist
-- exists as a user in CENTRO.
ALTER TABLE tenants  ADD COLUMN IF NOT EXISTS ghl_user_id text;
ALTER TABLE stylists ADD COLUMN IF NOT EXISTS ghl_user_id text;
