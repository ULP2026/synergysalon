-- Skin, a fifth kind of work beside Cuts, Treatments, Color and Styling
-- (Luis, 2026-11-13: "another category ... skin, and skin services includes
-- eyebrow wax and lip wax"). Category is plain text, so the kind needs no
-- schema change; these are its two services on the salon's list. The 15
-- minutes are estimates like the rest of the menu; a stylist's own minutes
-- beat them (timing.js). No price on the list: each stylist types theirs.
INSERT INTO services (tenant_id, slug, name, category, blurb, duration_min, buffer_min, price_cents, consult_first, sort_order)
SELECT t.id, x.slug, x.name, 'skin', x.blurb, 15, 5, NULL, false, x.sort
  FROM tenants t
 CROSS JOIN (VALUES ('eyebrow-wax', 'Eyebrow Wax', 'Brow shaping', 80),
                    ('lip-wax', 'Lip Wax', 'Lip hair removal', 81)) AS x(slug, name, blurb, sort)
 WHERE t.slug = 'synergy'
ON CONFLICT (tenant_id, slug) DO NOTHING;

-- A stylist who had added Eyebrow Wax or Lip Wax as their own service (Dina
-- did, under Treatments) now offers the salon's one instead: their price and
-- minutes move onto it (services.items), Skin is switched on for them, every
-- chair that offered the old one offers the new one, and the old one is
-- switched off, not deleted, because appointments may point at it. Runs
-- once per service: the old one is inactive afterwards.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT s.id, s.slug, s.tenant_id, s.owner_staff_id AS uid,
           CASE lower(btrim(s.name)) WHEN 'eyebrow wax' THEN 'eyebrow-wax' ELSE 'lip-wax' END AS to_slug
      FROM services s
     WHERE s.owner_staff_id IS NOT NULL AND s.active
       AND lower(btrim(s.name)) IN ('eyebrow wax', 'lip wax')
       AND EXISTS (SELECT 1 FROM services v WHERE v.tenant_id = s.tenant_id AND v.slug IN ('eyebrow-wax', 'lip-wax'))
  LOOP
    UPDATE staff_users u
       SET services = jsonb_set(
             jsonb_set(
               jsonb_set(COALESCE(u.services, '{}'::jsonb), '{items}', COALESCE(u.services -> 'items', '{}'::jsonb), true),
               '{skin}', COALESCE(u.services -> 'skin', '{}'::jsonb) || '{"on": true}'::jsonb, true),
             ARRAY['items', r.to_slug],
             COALESCE(u.services -> 'items' -> r.slug, '{}'::jsonb) || '{"on": true}'::jsonb, true)
     WHERE u.id = r.uid;
    INSERT INTO stylist_services (stylist_id, service_id)
    SELECT ss.stylist_id, v.id
      FROM stylist_services ss
      JOIN services v ON v.tenant_id = r.tenant_id AND v.slug = r.to_slug
     WHERE ss.service_id = r.id
    ON CONFLICT DO NOTHING;
    UPDATE services SET active = false WHERE id = r.id;
  END LOOP;
END $$;
