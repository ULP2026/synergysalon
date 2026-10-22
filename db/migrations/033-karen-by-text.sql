-- Karen by text and phone (asked for 2026-10-22).
--
-- The number clients call or text to reach Karen, shown in Settings, Karen
-- AI, Phone Number Settings, and used to tell which salon an incoming text
-- is for. The number itself is bought from the phone provider (Twilio) and
-- pointed at /api/staff/karen-sms; this only records which one it is.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS karen_phone text;

-- Where each conversation by text has got to: one row per phone number, so
-- "2" after a list of times means the second of those times. Short-lived:
-- karen-sms.js treats anything older than half an hour as a new
-- conversation. Additive, and in ensure-schema too.
CREATE TABLE IF NOT EXISTS karen_threads (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone      text NOT NULL,
  state      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, phone)
);
