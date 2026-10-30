-- Who made a booking when it was not a person (asked for 2026-10-31: a
-- client booked by Karen should read "Booked by Karen", not "Booked by
-- staff"). channel stays online or staff; booked_via says 'karen' for her
-- bookings, in the app and by text, and is empty for everything else.
--
-- Bookings Karen made by text before this carry her note, so they are
-- marked from it. Additive, and in ensure-schema too.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS booked_via text;
UPDATE appointments SET booked_via = 'karen'
 WHERE booked_via IS NULL AND notes = 'Booked by text with Karen.';
