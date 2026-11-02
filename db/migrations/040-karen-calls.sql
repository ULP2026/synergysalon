-- Karen's Call History (asked for 2026-11-02): every call to Karen's number,
-- who called (a team member or client by their number, else just the
-- number), and what happened: greeted, put through to the salon, and how
-- the salon's line answered (Twilio's DialCallStatus) and for how long.
--
-- Additive: a table of its own. Also in ensure-schema.
CREATE TABLE IF NOT EXISTS karen_calls (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_sid     text,
  from_phone   text,
  caller_kind  text,
  staff_id     uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  contact_id   uuid REFERENCES contacts(id) ON DELETE SET NULL,
  caller_name  text,
  forwarded_to text,
  dial_status  text,
  duration_sec int,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS karen_calls_sid ON karen_calls (call_sid) WHERE call_sid IS NOT NULL;
CREATE INDEX IF NOT EXISTS karen_calls_by_salon ON karen_calls (tenant_id, created_at DESC);
