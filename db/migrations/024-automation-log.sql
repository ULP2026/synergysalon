-- What the app has actually sent, and which automations are switched off.
--
-- Marketing, Automation showed four cards and no way to tell whether any of
-- them had ever fired. The salon asked for what PORTL shows: a count beside
-- each one, the people behind that count, and a switch.
--
-- Nothing recorded a send before this. The only trace was
-- appointments.reminder_sent_at, which answers "has this appointment been
-- reminded" and nothing else -- not how many, not to whom, and not for the
-- other three messages at all. So counts start from the day this runs; they
-- are not backfilled, because there is nothing honest to backfill them from.
--
-- The appointment is kept with ON DELETE SET NULL rather than CASCADE: a
-- deleted appointment must not quietly reduce a count of messages that really
-- were sent. to_email is stored on the row for the same reason -- the contact
-- may be edited or removed later, and "who we emailed" is a fact about the
-- past.
CREATE TABLE IF NOT EXISTS message_sends (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind           text NOT NULL,
  appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  to_name        text,
  to_email       text NOT NULL,
  sent_at        timestamptz NOT NULL DEFAULT now()
);

-- The list reads "newest first, for this salon, for this automation", which
-- is exactly this index.
CREATE INDEX IF NOT EXISTS message_sends_tenant_kind
  ON message_sends (tenant_id, kind, sent_at DESC);

-- Which automations are off. Off rather than on, so a salon that has never
-- touched the switches has everything running, and a message kind added later
-- is on by default instead of silently dark.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS automations_off text[] NOT NULL DEFAULT '{}';
