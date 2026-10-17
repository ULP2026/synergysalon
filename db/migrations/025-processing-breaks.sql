-- Processing breaks: a color appointment frees its stylist while it develops.
--
-- A color or highlights service is three parts: the stylist applies it
-- (Start), it processes while the guest sits (Break), and the stylist rinses,
-- tones and finishes (Finish). During the Break the stylist is free to take
-- somebody else, which is how a salon fills its day. Until now an appointment
-- was one solid range, so the database refused anything in that gap.
--
-- appointments.breaks holds each break as [minutes from the start, minutes
-- long], relative rather than absolute so that moving an appointment (every
-- UPDATE of starts_at in the code) carries its breaks with it untouched.
--
-- The no-overlap rule now compares only the parts the stylist is working:
-- appointment_blocks() is the appointment's range (start to end of the
-- clean-down) with its breaks cut out. The constraint is still the guarantee,
-- exactly as before; only what it compares has changed. ensure-schema.js
-- applies the same change on a warm function.
SET search_path = public, extensions;

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS breaks jsonb NOT NULL DEFAULT '[]'::jsonb;

-- IMMUTABLE so it can sit in the constraint's index. timestamptz + interval
-- is only STABLE in general because a day or a month depends on the
-- timezone; these intervals are minutes alone, which never do.
CREATE OR REPLACE FUNCTION appointment_blocks(starts timestamptz, ends timestamptz, breaks jsonb)
RETURNS tstzmultirange LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT tstzmultirange(tstzrange(starts, ends, '[)'))
         - COALESCE((SELECT range_agg(tstzrange(starts + make_interval(mins => (b->>0)::int),
                                               starts + make_interval(mins => (b->>0)::int + (b->>1)::int), '[)'))
                       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(breaks) = 'array' THEN breaks ELSE '[]'::jsonb END) b),
                    '{}'::tstzmultirange)
$$;

-- One statement, so there is no moment without a no-overlap rule: the old one
-- goes and the new one arrives together (or, if ensure-schema got here
-- first, the new one is rebuilt in place).
ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_no_overlap_blocks,
  DROP CONSTRAINT IF EXISTS appointments_no_overlap,
  ADD CONSTRAINT appointments_no_overlap_blocks
  EXCLUDE USING gist (stylist_id WITH =, appointment_blocks(starts_at, upper(during), breaks) WITH &&)
  WHERE (status <> 'cancelled');
