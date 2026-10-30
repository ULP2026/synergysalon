-- The email log, complete enough for a client's Activity (asked for
-- 2026-10-31): which email, its subject, when, and whether it went.
--
--   subject     the subject line as sent
--   status      'sent', or 'failed' when the provider refused it
--   error       the provider's reason, for a failed one
--   contact_id  the client it was sent to, so their Activity finds every
--               email, including one not tied to an appointment
--
-- Rows from before only recorded sends that went, so they are 'sent'; their
-- client comes from their appointment. Additive, and in ensure-schema too.
ALTER TABLE message_sends ADD COLUMN IF NOT EXISTS subject text;
ALTER TABLE message_sends ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'sent';
ALTER TABLE message_sends ADD COLUMN IF NOT EXISTS error text;
ALTER TABLE message_sends ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS message_sends_contact ON message_sends (contact_id, sent_at DESC);
UPDATE message_sends m SET contact_id = a.contact_id
  FROM appointments a
 WHERE a.id = m.appointment_id AND m.contact_id IS NULL AND a.contact_id IS NOT NULL;
