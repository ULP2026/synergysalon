-- Sent History says Failed when an email bounces (asked for 2026-11-02,
-- built 2026-11-12). Resend's id for each email the app sends, so its
-- email.bounced webhook can find the row (email-bounce.js). Older rows have
-- none and stay as they are. Also in ensure-schema.
ALTER TABLE message_sends ADD COLUMN IF NOT EXISTS provider_id text;
CREATE INDEX IF NOT EXISTS message_sends_provider ON message_sends (provider_id) WHERE provider_id IS NOT NULL;
