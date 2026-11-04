-- The invite link remembers where they got to (asked for 2026-11-04). Once
-- somebody chooses their password the link's hash moves here, so clicking
-- the same link again, before they finish setting up, takes them back to
-- their step rather than to "this link has expired". It never signs anybody
-- in or sets a password: it only says who it was for, so the page can send
-- them to their setup (signed in) or to sign in with their email filled in.
-- Cleared when setup is finished. Additive. Also in ensure-schema.
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS setup_hash text;
