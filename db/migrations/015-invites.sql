-- Invite a team member instead of choosing their password for them.
--
-- Adding somebody meant the owner typing a password and then telling them what
-- it was. That password travels by text message or a note on the desk, it is
-- known to two people from the start, and most people never change it.
--
-- An invite link does the same job without anybody else ever knowing the
-- password. Only the hash is stored, exactly as with a session token: a copy
-- of this table is not a set of working invites.
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS invite_hash       text;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS invite_expires_at timestamptz;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS invited_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS invited_at        timestamptz;

CREATE INDEX IF NOT EXISTS staff_users_invite ON staff_users (invite_hash)
  WHERE invite_hash IS NOT NULL;
