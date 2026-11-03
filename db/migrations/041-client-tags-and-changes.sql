-- The client profile, 2026-11-03.
--
-- Tags: the team's own labels for a client ("VIP", "Curly cut"), added,
-- renamed and removed from the profile's header. Free text, a few words each.
--
-- contact_changes: the profile's Admin history, one row for each change
-- the team makes to a client's record (name, phone, email, status, tags,
-- notes, contact preferences, card on file): what changed, from what to
-- what, who did it and when. Kept from this migration on; nothing earlier
-- recorded who changed what.
--
-- Additive: a column with a default and a table of its own. Also in
-- ensure-schema.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS contact_changes (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  changed_by  uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  who_name    text,
  field       text NOT NULL,
  old_value   text,
  new_value   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contact_changes_by_client ON contact_changes (tenant_id, contact_id, created_at DESC);
