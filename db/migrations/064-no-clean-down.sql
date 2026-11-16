-- Back-to-back bookings (customer report, 2026-11-16): every service's
-- clean-down to 0, so the next appointment can start the minute the last one
-- ends, and visits not yet over lose theirs. The whole service time still
-- blocks, and the no-overlap constraint is untouched. Once per database: the
-- column comment is the marker (api/_lib/clean-down.js holds the same
-- statement, which ensure-schema runs).
DO $$
BEGIN
  PERFORM set_config('lock_timeout', '3s', true);
  IF col_description('services'::regclass,
       (SELECT attnum FROM pg_attribute WHERE attrelid = 'services'::regclass AND attname = 'buffer_min'))
     IS DISTINCT FROM 'Clean-down after a visit, in minutes. Every one set to 0 on 2026-11-16 (back-to-back bookings).' THEN
    UPDATE services SET buffer_min = 0 WHERE buffer_min > 0;
    UPDATE appointments
       SET buffer_min = 0,
           during = tstzrange(starts_at, starts_at + make_interval(mins => duration_min), '[)')
     WHERE buffer_min > 0 AND status = 'booked' AND upper(during) > now();
    ALTER TABLE services ALTER COLUMN buffer_min SET DEFAULT 0;
    COMMENT ON COLUMN services.buffer_min IS 'Clean-down after a visit, in minutes. Every one set to 0 on 2026-11-16 (back-to-back bookings).';
  END IF;
END $$;
