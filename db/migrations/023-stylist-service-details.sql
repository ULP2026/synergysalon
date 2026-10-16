-- Prices, lengths and notes for a stylist without a sign-in.
--
-- A team member's services live in staff_users.services, with the price,
-- length and notes typed beside each one. A stylist who never signs in has no
-- staff_users row, so until now only their switches were kept (as
-- stylist_services) and what was typed beside them was lost on save.
-- Same shape as staff_users.services. ensure-schema.js runs this too.
ALTER TABLE stylists ADD COLUMN IF NOT EXISTS service_details jsonb NOT NULL DEFAULT '{}'::jsonb;
