-- Shampoo Blowout under Styling (asked for 2026-11-06): a wash and blowout,
-- between Blowout & Styling and Updos. The 45 minutes is an industry
-- estimate like the rest of the menu until Dina gives hers; a stylist's own
-- minutes beat it (timing.js).
INSERT INTO services (tenant_id, slug, name, category, blurb, duration_min, buffer_min, price_cents, consult_first, sort_order)
SELECT t.id, 'shampoo-blowout', 'Shampoo Blowout', 'styling', 'Wash, blow-dry and style', 45, 10, NULL, false, 85
  FROM tenants t
 WHERE t.slug = 'synergy'
ON CONFLICT (tenant_id, slug) DO NOTHING;

-- Whoever already offers Styling offers it too, as roster.js would on their
-- next save; once only, so a stylist who unticks it keeps it unticked.
INSERT INTO stylist_services (stylist_id, service_id)
SELECT DISTINCT ss.stylist_id, v.id
  FROM stylist_services ss
  JOIN services o ON o.id = ss.service_id
  JOIN services v ON v.tenant_id = o.tenant_id AND v.category = o.category
 WHERE v.slug = 'shampoo-blowout'
   AND v.owner_staff_id IS NULL AND o.owner_staff_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM stylist_services z WHERE z.service_id = v.id)
ON CONFLICT DO NOTHING;
