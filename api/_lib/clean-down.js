/**
 * Back-to-back bookings (customer report, 2026-11-16: "I cannot book the next
 * appointment at the time the previous one ends; the app forces at least 15
 * minutes in between").
 *
 * The gap was each service's clean-down, `services.buffer_min`: an estimate
 * seeded with the menu (5 to 15 minutes), never shown or set in the app. It
 * held the stylist after every visit (availability.js, cleanDown), was
 * stored in every appointment's `during`, and so was enforced by the
 * no-overlap constraint as well. Inside another client's processing break
 * it was skipped on purpose, which is why the salon saw no gap there.
 *
 * The salon books back to back, so every clean-down goes to 0. The code that
 * honours a clean-down stays: a service given one deliberately later keeps
 * it. What still blocks is the whole service time, breaks aside, exactly as
 * before; shortening what an appointment holds can never make two overlap.
 *
 * Visits already booked and not yet over lose theirs too, or a booking made
 * before this would still hold its stylist for the old 15 minutes. Past
 * visits keep theirs: that is what was booked. `updated_at` is left alone,
 * so the Google copies (whose end time never included the clean-down) are
 * not all sent again.
 */

/** Marks the database as done, so ensure-schema never zeroes a clean-down set on purpose later. */
export const CLEAN_DOWN_MARK = 'Clean-down after a visit, in minutes. Every one set to 0 on 2026-11-16 (back-to-back bookings).';

const ZERO_SERVICES = `UPDATE services SET buffer_min = 0
   WHERE buffer_min > 0 AND ($1::uuid IS NULL OR tenant_id = $1::uuid)`;
const ZERO_BOOKED = `UPDATE appointments
     SET buffer_min = 0,
         during = tstzrange(starts_at, starts_at + make_interval(mins => duration_min), '[)')
   WHERE buffer_min > 0 AND status = 'booked' AND upper(during) > now()
     AND ($1::uuid IS NULL OR tenant_id = $1::uuid)`;

/** The change itself, for every salon or one (tests). Returns how many of each changed. */
export async function dropCleanDowns(q, tenantId = null) {
  const s = await q(ZERO_SERVICES, [tenantId]);
  const a = await q(ZERO_BOOKED, [tenantId]);
  return { services: s.rowCount, appointments: a.rowCount };
}

/**
 * Once per database (ensure-schema and migration 064): the column's comment
 * is the marker, set in the same statement as the change. It waits at most
 * three seconds for the services table (changing its default needs it to
 * itself): on a busy cold start it gives up, ensure-schema logs it, and the
 * next cold start tries again, rather than holding every booking behind it.
 */
export const DROP_CLEAN_DOWNS_ONCE = `DO $$
BEGIN
  PERFORM set_config('lock_timeout', '3s', true);
  IF col_description('services'::regclass,
       (SELECT attnum FROM pg_attribute WHERE attrelid = 'services'::regclass AND attname = 'buffer_min'))
     IS DISTINCT FROM '${CLEAN_DOWN_MARK}' THEN
    UPDATE services SET buffer_min = 0 WHERE buffer_min > 0;
    UPDATE appointments
       SET buffer_min = 0,
           during = tstzrange(starts_at, starts_at + make_interval(mins => duration_min), '[)')
     WHERE buffer_min > 0 AND status = 'booked' AND upper(during) > now();
    ALTER TABLE services ALTER COLUMN buffer_min SET DEFAULT 0;
    COMMENT ON COLUMN services.buffer_min IS '${CLEAN_DOWN_MARK}';
  END IF;
END $$`;
