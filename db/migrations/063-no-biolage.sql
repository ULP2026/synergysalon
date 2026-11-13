-- Biolage Highlights off the menu (Luis, 2026-11-13: "delete biolage
-- highlights"). Switched off, never deleted: past appointments point at it.
UPDATE services SET active = false WHERE slug = 'biolage-highlights' AND active;
