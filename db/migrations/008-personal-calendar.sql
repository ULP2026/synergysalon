-- A calendar link belongs to a person, not to a chair.
--
-- The first version handed out one link per stylist and listed all of them on
-- one page, so everybody could read everybody's. A calendar link is a
-- credential, and the person it belongs to is the only one who needs it.
--
-- Giving the token to the user rather than the stylist also means it works
-- for the people who do not stand behind a chair. An owner or a front-desk
-- account has no stylist row, and under the old shape simply had no calendar
-- at all -- which is backwards, since they are the ones who want to see the
-- whole day.
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS calendar_token text;

UPDATE staff_users
   SET calendar_token = replace(gen_random_uuid()::text, '-', '')
                     || replace(gen_random_uuid()::text, '-', '')
 WHERE calendar_token IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS staff_users_calendar_token
  ON staff_users (calendar_token) WHERE calendar_token IS NOT NULL;
