-- Where somebody stopped in onboarding (asked for 2026-11-04): a reload, a
-- closed tab or signing in again used to start them at step one. The step
-- they are on is saved as they move ('details', 'services', 'hours',
-- 'calendar', 'review') and cleared when they finish; what they typed is
-- saved on the account itself as they go. Additive. Also in ensure-schema.
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS onboarding_step text;
