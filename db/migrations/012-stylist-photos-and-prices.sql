-- Stylist photos, and each person's own service prices.
--
-- Photos: the day view's columns showed initials, which nobody at a front
-- desk reads at a glance. These are the portraits already published on the
-- public site's team section, so nothing new is being made public. A login's
-- own avatar, when it has one, still wins over these (see me.js).
ALTER TABLE stylists ADD COLUMN IF NOT EXISTS photo text;

UPDATE stylists s SET photo = v.photo
  FROM tenants t, (VALUES
    ('dina',  '/assets/327bffc0-8c69-40d5-95e6-d5606dcfd055.webp'),
    ('micah', '/assets/6aec6da9-e6b5-44e1-885c-290acabf56c8.webp'),
    ('tami',  '/assets/040961f5-e03d-48bb-8574-b5b1708a7c72.webp'),
    ('kim',   '/assets/212524d4-61d2-4843-b817-b2b37d34691d.jpg')
  ) AS v(slug, photo)
 WHERE t.id = s.tenant_id AND t.slug = 'synergy' AND s.slug = v.slug AND s.photo IS NULL;

-- What a stylist offers and charges, by the four kinds of work the salon
-- does: {"cuts": {"on": true, "price": 65}, "color": {"on": false}, ...}.
-- Typed in by the stylist or an owner, never worked out by the app: the PMC
-- blocks invented prices, and these are theirs to stand by. Kept per person
-- rather than on services because two stylists charge differently for the
-- same cut.
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS services jsonb NOT NULL DEFAULT '{}'::jsonb;
