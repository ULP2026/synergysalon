-- Forgot Password? (asked for 2026-11-06). A reset link is a random token;
-- only its SHA-256 is kept, it lasts an hour, and it is spent the moment a
-- new password is set. reset_requested_at spaces requests out, so the form
-- cannot be used to flood somebody's inbox. api/staff/_routes/reset.js.
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS reset_hash text;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS reset_expires_at timestamptz;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS reset_requested_at timestamptz;
CREATE INDEX IF NOT EXISTS staff_users_reset_hash ON staff_users (reset_hash) WHERE reset_hash IS NOT NULL;
