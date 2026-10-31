-- Karen's message history (asked for 2026-10-31): every message between a
-- team member and Karen, in the app's chat or by text, kept so the owner can
-- read them in Settings, Karen AI, Message History.
--
-- karen_threads holds only where a texted conversation has got to, and is
-- overwritten and forgotten after half an hour; the app's chat kept nothing.
-- This keeps everything, one row a message. Additive: a table of its own,
-- nothing existing touched. Also in ensure-schema.
CREATE TABLE IF NOT EXISTS karen_messages (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Who was talking to her. A team member removed later keeps their history
  -- under the name they had (who_name), with the link cleared.
  user_id    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  who_name   text,
  channel    text NOT NULL CHECK (channel IN ('app', 'text')),
  role       text NOT NULL CHECK (role IN ('user', 'karen')),
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The inbox reads "for this salon, this person, newest first".
CREATE INDEX IF NOT EXISTS karen_messages_by_person
  ON karen_messages (tenant_id, user_id, created_at DESC);
