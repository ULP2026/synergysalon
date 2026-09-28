-- The services the booking wizard actually offers.
--
-- The menu held ten services; the wizard offers twenty, and mapping several of
-- its options onto one row was doing real damage. A bang trim booked as a
-- sixty-minute haircut takes an hour of a stylist's day for five minutes of
-- work, and "Color & cut" booked as a cut runs two hours short.
--
-- Slugs match the wizard's own labels so the mapping is one to one and nothing
-- has to be guessed at either end.
--
-- EVERY DURATION HERE IS AN INDUSTRY-STANDARD ESTIMATE AND NEEDS DINA.
-- They decide which slots get sold, so a wrong number either wastes a chair or
-- sells an appointment that cannot be finished on time.

BEGIN;

INSERT INTO services (tenant_id, slug, name, category, blurb, duration_min, buffer_min, price_cents, consult_first, sort_order)
SELECT t.id, v.*
FROM tenants t, (VALUES
  ('single-process-color', 'Single Process Color',  'color',      'All-over color or root touch-up',  90, 15, NULL::integer, false, 11),
  ('biolage-highlights',   'Biolage Highlights',    'color',      'Gentle, low-ammonia lift',        150, 15, NULL,          false, 21),
  ('gloss-or-toner',       'Gloss or Toner',        'color',      'Shine and tone refresh',           45, 10, NULL,          false, 22),
  ('color-and-cut',        'Color & Cut',           'color',      'The full refresh',                180, 15, NULL,          false, 31),
  ('womens-cut',           'Women''s Cut',          'cuts',       'Consultation, cut and style',      60, 10, NULL,          false, 71),
  ('mens-cut',             'Men''s Cut',            'cuts',       'Clipper or scissor',               30, 10, NULL,          false, 72),
  ('teen-cut',             'Teen Cut',              'cuts',       'Ages 13 to 17',                    45, 10, NULL,          false, 73),
  ('kids-cut',             'Kids'' Cut',            'cuts',       '12 and under',                     30, 10, NULL,          false, 74),
  ('bang-trim',            'Bang Trim',             'cuts',       'Quick in-between refresh',         15,  5, NULL,          false, 75),
  ('bridal-styling',       'Bridal Styling',        'styling',    'Bride and bridal party',          120, 15, NULL,          true,  91)
) AS v(slug, name, category, blurb, duration_min, buffer_min, price_cents, consult_first, sort_order)
WHERE t.slug = 'synergy'
ON CONFLICT (tenant_id, slug) DO NOTHING;

-- Every stylist offers the new services too, matching how the existing ones
-- are set up. Narrow this when Dina says who actually does what.
INSERT INTO stylist_services (stylist_id, service_id)
SELECT s.id, v.id
FROM stylists s
JOIN services v ON v.tenant_id = s.tenant_id
ON CONFLICT DO NOTHING;

COMMIT;
