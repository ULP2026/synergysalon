-- The clean-down after an appointment stops reserving the stylist's time.
--
-- A color frees its stylist while it develops (migration 025), and the diary
-- draws that gap: the Start, the Processing left open, then the Finish. On
-- 21 October a 45 minute service would not go into a 45 minute gap. Nothing
-- was booked in it and nothing was wrong with the gap; the check was
-- comparing time the salon cannot see.
--
-- Two invisible stretches were being added. The appointment already there
-- was compared over upper(during), which runs to the end of its clean-down
-- rather than to the end of its Finish, and the booking being tried carried
-- its own clean-down on the end. A 45 minute service needed 55 minutes of
-- gap, and the 10 it was short are minutes no screen in the app draws.
--
-- So what the constraint compares is now the guest's own time with the
-- breaks cut out: starts_at to starts_at + duration_min. The clean-down is
-- still stored, still inside during, and still drawn nowhere; it simply no
-- longer refuses a booking. It was already allowed to run past closing time
-- for the same reason -- it is time the salon schedules, not time it sells.
--
-- availability.js compares exactly this (workSpans in timing.js), so what
-- the website, the staff console and a guest moving their own booking offer
-- is what the database accepts.
SET search_path = public, extensions;

-- By minutes rather than by an end instant, so the addition happens inside a
-- function declared IMMUTABLE and the whole thing can sit in the
-- constraint's index. timestamptz + interval is only STABLE in general,
-- because a day or a month depends on the timezone; minutes never do.
CREATE OR REPLACE FUNCTION appointment_blocks(starts timestamptz, minutes integer, breaks jsonb)
RETURNS tstzmultirange LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT tstzmultirange(tstzrange(starts, starts + make_interval(mins => minutes), '[)'))
         - COALESCE((SELECT range_agg(tstzrange(starts + make_interval(mins => (b->>0)::int),
                                               starts + make_interval(mins => (b->>0)::int + (b->>1)::int), '[)'))
                       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(breaks) = 'array' THEN breaks ELSE '[]'::jsonb END) b),
                    '{}'::tstzmultirange)
$$;

-- One statement, so there is no moment without a no-overlap rule.
--
-- The constraint keeps its name on purpose. An instance of the old code may
-- still be serving while this runs, and its ensure-schema leaves a
-- constraint of this name alone; renaming it would invite that instance to
-- add the old rule back alongside this one.
ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_no_overlap_blocks,
  DROP CONSTRAINT IF EXISTS appointments_no_overlap,
  ADD CONSTRAINT appointments_no_overlap_blocks
  EXCLUDE USING gist (stylist_id WITH =, appointment_blocks(starts_at, duration_min, breaks) WITH &&)
  WHERE (status <> 'cancelled');
