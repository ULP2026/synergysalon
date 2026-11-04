-- Texts to the team, kept (asked for 2026-11-04): the welcome Karen texts
-- somebody invited to the team, so the Team Member Invitation automation's
-- Sent History shows it beside the welcome email, sent or failed.
--
-- A table of its own rather than client_texts, whose contact_id is required:
-- a team member is not a client. staff_user_id lets go when they are
-- removed, and the row stays, because "who we texted" is a fact about the
-- past. Additive. Also in ensure-schema.
CREATE TABLE IF NOT EXISTS team_texts (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_user_id uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  kind          text NOT NULL,
  to_name       text,
  phone         text,
  body          text NOT NULL,
  status        text NOT NULL DEFAULT 'sent',
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS team_texts_by_kind ON team_texts (tenant_id, kind, created_at DESC);
