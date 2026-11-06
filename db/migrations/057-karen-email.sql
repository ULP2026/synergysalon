-- Karen answers the salon's email (asked for 2026-11-06). Mail sent to the
-- salon's reply-to inbox (admin@) is copied by a Google Workspace rule to
-- Karen's receiving address at Resend, which hands it to the app
-- (api/staff/_routes/karen-mail.js, api/_lib/karen-email.js).
--
-- A conversation is a thread with one person; each email in or out is a
-- message in it. Duplicates are stopped here, not in code: the same email
-- (its Message-ID, or Resend's id for it) is stored once, and an email is
-- answered at most once (`answers` is unique).
CREATE TABLE IF NOT EXISTS email_threads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  counterpart_email text NOT NULL,
  counterpart_name  text NOT NULL DEFAULT '',
  subject           text NOT NULL DEFAULT '',
  contact_id        uuid REFERENCES contacts(id) ON DELETE SET NULL,
  staff_user_id     uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  -- open (waiting), answered (Karen replied), flagged (for a person),
  -- skipped (not for Karen: automatic mail, newsletters, not the salon's business)
  status            text NOT NULL DEFAULT 'open',
  last_at           timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_threads_recent ON email_threads (tenant_id, last_at DESC);
CREATE INDEX IF NOT EXISTS email_threads_who ON email_threads (tenant_id, lower(counterpart_email));

CREATE TABLE IF NOT EXISTS email_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  thread_id    uuid NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE,
  direction    text NOT NULL CHECK (direction IN ('in', 'out')),
  message_id   text,
  provider_id  text,
  in_reply_to  text,
  refs         text NOT NULL DEFAULT '',
  from_email   text NOT NULL,
  from_name    text NOT NULL DEFAULT '',
  to_email     text NOT NULL DEFAULT '',
  subject      text NOT NULL DEFAULT '',
  body         text NOT NULL DEFAULT '',
  -- in: received | replied | flagged | skipped | failed; out: sending | sent | failed
  status       text NOT NULL,
  note         text NOT NULL DEFAULT '',
  answers      uuid REFERENCES email_messages(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS email_messages_msgid ON email_messages (tenant_id, message_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS email_messages_received ON email_messages (provider_id) WHERE provider_id IS NOT NULL AND direction = 'in';
CREATE UNIQUE INDEX IF NOT EXISTS email_messages_one_answer ON email_messages (answers) WHERE answers IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_messages_thread ON email_messages (thread_id, created_at);

-- The owner's switch: Karen answers emails on her own, or only files them.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS karen_email_on boolean NOT NULL DEFAULT true;
