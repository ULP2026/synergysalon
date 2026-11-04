-- A service of one stylist's own (asked for 2026-11-04): a stylist can add a
-- service the salon's list does not have, and it is offered only with them.
-- owner_staff_id is the team member it belongs to; NULL is the salon's own
-- list, which every stylist with that kind switched on offers (roster.js).
--
-- No foreign key, on purpose: ON DELETE SET NULL would hand a removed
-- stylist's service to everybody, and CASCADE would delete a row that
-- appointments point at. Removing somebody switches their services off
-- instead (team.js). Additive. Also in ensure-schema.
ALTER TABLE services ADD COLUMN IF NOT EXISTS owner_staff_id uuid;
CREATE INDEX IF NOT EXISTS services_by_owner ON services (tenant_id, owner_staff_id) WHERE owner_staff_id IS NOT NULL;
