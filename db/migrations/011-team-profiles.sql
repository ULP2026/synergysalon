-- Team profiles: a username each person chooses, and how their work is priced.
--
-- The username is what a stylist goes by in the console. It is optional and
-- unique per salon, compared without case, because "Jessi" and "jessi" being
-- two people is a mistake nobody means to make.
--
-- Pricing is free text that an owner or manager writes ("Senior stylist
-- pricing", "By consultation"), never a number the app works out. The PMC
-- blocks invented prices; a sentence an owner typed is theirs to stand by.
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS username text;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS pricing  text NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS staff_users_username
  ON staff_users (tenant_id, lower(username)) WHERE username IS NOT NULL;
