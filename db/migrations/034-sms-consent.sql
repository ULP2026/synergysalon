-- Texting consent on the client record (asked for 2026-10-28).
--
-- Karen now texts appointment confirmations, moves, cancellations and the
-- day-before reminder, but only to clients whose consent is on record:
-- the salon's A2P 10DLC registration says texts go only to people who
-- ticked the box on synergysalon.com/sms-opt-in (or replied START), and
-- contacts.sms_ok (031) defaults to true, so it cannot say who agreed.
--
--   sms_consent_at      when they agreed; NULL = no texts (STOP clears it)
--   sms_consent_source  how ("Website opt-in form", "Replied START", "Replied STOP")
--   sms_consent_phone   the ten digits they agreed for, which is where texts go
--
-- Additive, and in ensure-schema too.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sms_consent_at timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sms_consent_source text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sms_consent_phone text;
