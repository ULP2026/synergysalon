-- "Haircut" off the menu (asked for 2026-11-05). Cuts already has Women's,
-- Men's, Teen and Kids' Cut and the Bang Trim (004), which is what the
-- website's survey offers; the generic "Haircut" from the first seed was
-- the one Cuts service nobody could pick online, and it showed as a sixth
-- choice under Cuts in the app. Switched off rather than deleted: past
-- appointments point at it and keep their name.
UPDATE services SET active = false WHERE slug = 'haircuts' AND active;
