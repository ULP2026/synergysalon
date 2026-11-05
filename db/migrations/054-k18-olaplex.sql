-- Bond Repair is called "K18/Olaplex Treatment" (asked for 2026-11-06).
-- Same service and slug, so its bookings, prices and stylists stay.
UPDATE services SET name = 'K18/Olaplex Treatment'
 WHERE owner_staff_id IS NULL AND slug = 'bond-repair' AND name <> 'K18/Olaplex Treatment';
