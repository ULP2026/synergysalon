-- The salon's Hours of Operation (asked for 2026-11-06), set on Settings,
-- Salon. Seven entries, Sunday first, each {"open": "HH:MM", "close":
-- "HH:MM"} or null for closed (api/_lib/hours.js). Null as a whole means
-- never set: the app shows the hours the website showed before.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS hours jsonb;
