-- A team member's job title ("Master Stylist", "Front Desk"), asked for at
-- onboarding's first step with their other work details (2026-11-03). Kept on
-- the login, because somebody new has no chair yet; copied to their stylist
-- row (stylists.title, what the website survey shows) whenever it is synced.
-- Additive. Also in ensure-schema.
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS job_title text;
