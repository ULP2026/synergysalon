-- The service menu as the salon asked for it on 2026-11-05.
--
-- Cuts: no Teen Cut (Women's, Men's, Kids' and the Bang Trim).
-- Treatments: Condition Treatment and Mask Treatment added; Bond Repair is
--   one service, "Bond Repair: Olaplex & K18" (the survey offered Olaplex
--   and K18 as two choices of the same booking).
-- Color: Highlights & Foils and Color & Cut leave the list; Partial
--   Highlights and Full Highlights come in, each its own service, timed by
--   its own Start, Break and Finish in a stylist's Color settings. Balayage,
--   Single Process Color, Biolage Highlights, Gloss or Toner and Corrective
--   Color stay.
-- Styling: Bridal Styling and Special Event & Updo are one service, Updos
--   (kept on the special-event slug, so its bookings and links stay);
--   Extensions is renamed Consultation (same slug, still consult first).
--
-- Nothing is deleted: a service switched off keeps its name on the
-- appointments that point at it. New durations are industry estimates, like
-- every other one here, until Dina gives hers; a stylist's own minutes beat
-- them anyway (timing.js). Salon services only: a stylist's own services
-- (owner_staff_id) are theirs to change.

UPDATE services SET active = false
 WHERE owner_staff_id IS NULL AND active
   AND slug IN ('teen-cut', 'highlights-and-foils', 'color-and-cut', 'bridal-styling');

UPDATE services SET name = 'Bond Repair: Olaplex & K18', blurb = 'Rebuild what damage broke'
 WHERE owner_staff_id IS NULL AND slug = 'bond-repair';
UPDATE services SET name = 'Updos', blurb = 'Weddings, bridal parties, prom and special events'
 WHERE owner_staff_id IS NULL AND slug = 'special-event';
UPDATE services SET name = 'Consultation', blurb = 'Talk it through with your stylist first', consult_first = true
 WHERE owner_staff_id IS NULL AND slug = 'extensions';

INSERT INTO services (tenant_id, slug, name, category, blurb, duration_min, buffer_min, price_cents, consult_first, sort_order)
SELECT t.id, v.*
FROM tenants t, (VALUES
  ('partial-highlights',  'Partial Highlights',  'color',      'Face-framing and crown',          120, 15, NULL::integer, false, 18),
  ('full-highlights',     'Full Highlights',     'color',      'All over, root to end',           150, 15, NULL,          false, 19),
  ('condition-treatment', 'Condition Treatment', 'treatments', 'Deep conditioning, soft and healthy', 30, 10, NULL,      false, 52),
  ('mask-treatment',      'Mask Treatment',      'treatments', 'A nourishing hair mask',           30, 10, NULL,          false, 54)
) AS v(slug, name, category, blurb, duration_min, buffer_min, price_cents, consult_first, sort_order)
WHERE t.slug = 'synergy'
ON CONFLICT (tenant_id, slug) DO NOTHING;

-- Whoever already offers a kind offers its new services too, as roster.js
-- would on their next save (a service with no entry of its own is offered
-- whenever its kind is on), so they are bookable straight away.
INSERT INTO stylist_services (stylist_id, service_id)
SELECT DISTINCT ss.stylist_id, v.id
  FROM stylist_services ss
  JOIN services o ON o.id = ss.service_id
  JOIN services v ON v.tenant_id = o.tenant_id AND v.category = o.category
 WHERE v.slug IN ('partial-highlights', 'full-highlights', 'condition-treatment', 'mask-treatment')
   AND v.owner_staff_id IS NULL AND o.owner_staff_id IS NULL
   -- once only: a service already linked to anybody is left to roster.js,
   -- so a stylist who unticks one is not given it back on the next start
   AND NOT EXISTS (SELECT 1 FROM stylist_services z WHERE z.service_id = v.id)
ON CONFLICT DO NOTHING;
