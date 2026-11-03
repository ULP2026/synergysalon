-- Onboarding for new team members (asked for 2026-11-03): somebody added to
-- the team completes their own account (name, mobile, picture, and for a
-- stylist their services and prices) before the rest of the app opens.
--
-- onboarded_at is when they finished. Everyone already on the team when this
-- runs is counted as done: the column is added with now() as its default,
-- which fills every existing row, and the default is then dropped so every
-- row inserted afterwards starts at NULL, that is, not onboarded yet.
-- Owners and admins are never held at onboarding (auth.js), whatever this
-- says. Also in ensure-schema, in the same two steps, which are safe to run
-- again: the column already existing means nothing is refilled.
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS onboarded_at timestamptz DEFAULT now();
ALTER TABLE staff_users ALTER COLUMN onboarded_at DROP DEFAULT;
