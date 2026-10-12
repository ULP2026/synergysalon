-- The Home dashboard's layout, chosen by the salon's admin in the console
-- (Customize on Home). Which widgets, in what order, as what kind of graphic
-- and how wide. One per salon, because everybody on the team looks at the
-- same Home; null means the default layout in api/staff/_routes/home.js.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS home_layout jsonb;
