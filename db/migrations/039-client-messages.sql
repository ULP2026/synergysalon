-- Messaging a client from their profile (asked for 2026-10-31): the team
-- writes a text or an email to a client, and every text with a client is
-- kept so their Activity shows the conversation.
--
-- Additive: a column nobody reads until it is written, and a table of its
-- own. Also in ensure-schema.

-- The words of an email the team wrote by hand, so it can be opened again
-- from the client's Activity. The automatic emails are rebuilt from their
-- booking instead (business.js, sentMessage), and leave this empty.
ALTER TABLE message_sends ADD COLUMN IF NOT EXISTS body text;

-- Every text with a client, either way: what the team sent from the
-- profile (kind 'direct'), the appointment texts (their kind), and the
-- client's conversation with Karen (kind 'karen', in and out).
CREATE TABLE IF NOT EXISTS client_texts (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  direction  text NOT NULL CHECK (direction IN ('out', 'in')),
  kind       text NOT NULL,
  phone      text,
  body       text NOT NULL,
  sent_by    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  status     text NOT NULL DEFAULT 'sent',
  error      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_texts_by_client
  ON client_texts (tenant_id, contact_id, created_at DESC);
