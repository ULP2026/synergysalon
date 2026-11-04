-- Stylists in Settings (asked for 2026-11-04).
--
-- Their own automation switches: a stylist can turn an automation off for
-- their own clients without touching the salon's switch (tenants.
-- automations_off), which stays the owner's. A message about a visit in
-- their chair is sent only when both are on (email.js, sendMessage).
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS automations_off text[] NOT NULL DEFAULT '{}';

-- A stylist asking to be paid out. The app moves no money: this is the
-- request, which the owner sees in Settings, Money and marks paid (or
-- declines) once they have paid it however the salon pays. Kept with the
-- stylist's name as it was, because "who asked" is a fact about the past.
CREATE TABLE IF NOT EXISTS cashout_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_user_id uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  staff_name    text NOT NULL,
  amount_cents  int NOT NULL CHECK (amount_cents > 0),
  note          text,
  status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'paid', 'declined')),
  decided_by    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cashout_requests_by_salon ON cashout_requests (tenant_id, created_at DESC);
