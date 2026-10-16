-- Removed from the team means gone from the team.
--
-- Removing somebody deletes their login but keeps their stylists row, switched
-- off, because appointments point at it and past work keeps its name. With the
-- login gone that row has no staff_user_id, which is exactly what a stylist
-- who never signs in looks like, so the Team list showed the person just
-- removed again on the next load, as a stylist without a sign-in.
--
-- removed_at says the row is history, not a member. The Team list, the
-- website and the booking engine leave it out; the diary still shows its
-- appointments under the name.
ALTER TABLE stylists ADD COLUMN IF NOT EXISTS removed_at timestamptz;

-- People removed before this column existed. At Synergy the only stylists
-- without a sign-in are the four the salon started with (GOOGLE_OPTIONAL_STYLISTS
-- in config.js); any other switched-off row with no login is somebody who was
-- removed. ensure-schema.js runs the same statement on the live database.
UPDATE stylists SET removed_at = now()
 WHERE removed_at IS NULL AND staff_user_id IS NULL AND NOT active
   AND tenant_id IN (SELECT id FROM tenants WHERE slug = 'synergy')
   AND slug <> ALL (ARRAY['dina', 'micah', 'tami', 'kim']);
