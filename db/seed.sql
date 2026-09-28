-- Starting data for the booking system.
--
-- The services and their ids match the sections already published on the
-- service pages, so /hair-color-valrico#balayage and the booking flow are
-- talking about the same thing.
--
-- TWO THINGS HERE ARE PLACEHOLDERS AND MUST BE CONFIRMED BY DINA:
--
--   duration_min  Industry-standard defaults. These drive availability, so a
--                 wrong number sells a slot the salon cannot honour. Every
--                 one of them needs checking against how long the work
--                 actually takes at Synergy.
--   price_cents   Left NULL on purpose. The price menu is still the top
--                 blocking item in the PMC, and wrong prices are worse than
--                 none. AI scalp analysis is the single cleared price.

BEGIN;

INSERT INTO services (id, name, category, blurb, duration_min, buffer_min, price_cents, consult_first, sort_order) VALUES
  ('balayage',                     'Balayage',                    'color',      'Hand-painted, sun-kissed, grows out gracefully',        180, 15, NULL,  false, 10),
  ('highlights-and-foils',         'Highlights & Foils',          'color',      'Partial, full and Biolage highlights',                  150, 15, NULL,  false, 20),
  ('corrective-color',             'Corrective Color',            'color',      'We fix what other salons and boxes got wrong',          240, 15, NULL,  true,  30),
  ('keratin-and-brazilian-blowout','Keratin & Brazilian Blowout', 'treatments', 'Florida humidity does not get a say',                   150, 15, NULL,  false, 40),
  ('bond-repair',                  'Bond Repair: Olaplex & K18',  'treatments', 'Rebuild what damage broke',                              45, 10, NULL,  false, 50),
  ('ai-scalp-analysis',            'AI Scalp Analysis',           'treatments', 'See what is happening at the root',                      30, 10, 4000,  false, 60),
  ('haircuts',                     'Haircut',                     'cuts',       'Women, men, teens, kids and bangs',                      60, 10, NULL,  false, 70),
  ('blowouts',                     'Blowout & Styling',           'styling',    'Walk out camera-ready',                                  45, 10, NULL,  false, 80),
  ('special-event',                'Special Event & Updo',        'styling',    'Weddings, galas, the reunion',                           75, 15, NULL,  false, 90),
  ('extensions',                   'Extensions',                  'styling',    'By consultation',                                       120, 15, NULL,  true, 100);

-- Order matches the team section on the homepage.
INSERT INTO stylists (id, name, title, sort_order) VALUES
  ('dina',  'Dina Lara',     'Owner, Master Colorist & Stylist', 10),
  ('micah', 'Micah Shadle',  'Master Stylist',                   20),
  ('tami',  'Tami Vomaro',   'Master Stylist',                   30),
  ('kim',   'Kim Batarlis',  'Master Stylist',                   40);

-- For now every stylist offers every service. Narrow this as soon as Dina
-- says who does what: it is the difference between "first available" meaning
-- anyone and meaning anyone who can actually do the work.
INSERT INTO stylist_services (stylist_id, service_id)
SELECT s.id, v.id FROM stylists s CROSS JOIN services v;

-- Salon hours, applied to all four stylists until individual schedules are
-- supplied. 0 = Sunday, and Sunday is deliberately absent: the salon is shut.
INSERT INTO stylist_hours (stylist_id, weekday, starts_at, ends_at)
SELECT s.id, h.weekday, h.starts_at, h.ends_at
FROM stylists s
CROSS JOIN (VALUES
  (1, TIME '09:00', TIME '15:00'),   -- Monday
  (2, TIME '09:00', TIME '15:00'),   -- Tuesday
  (3, TIME '09:00', TIME '19:00'),   -- Wednesday
  (4, TIME '09:00', TIME '19:00'),   -- Thursday
  (5, TIME '09:00', TIME '18:00'),   -- Friday
  (6, TIME '09:00', TIME '15:00')    -- Saturday
) AS h(weekday, starts_at, ends_at);

COMMIT;
