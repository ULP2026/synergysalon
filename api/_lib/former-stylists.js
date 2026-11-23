/**
 * Micah Shadle is no longer with the salon (asked for 2026-11-23: "remove her
 * also on the app", after she was taken off the website).
 *
 * This is what "Remove from team" in the app does (team.js, `delete`), done
 * once from here because she has no button the agency could press for her
 * with certainty: her chair may or may not have a login, and nobody can sign
 * in as the salon from this side. So:
 *
 * - her chair is switched off and marked removed. The row itself stays,
 *   because appointments point at it and past visits keep her name, exactly
 *   as for anybody removed in the app;
 * - its stored portrait is cleared, so the app draws a default face rather
 *   than pointing at a file that has been deleted;
 * - a login of hers (linked to the chair, or named Micah Shadle) is deleted,
 *   with the services that were hers alone switched off first, as team.js
 *   does. If something still points at the login with no rule for letting
 *   go, the login is left and the rest still happens;
 * - visits of hers still to come stay booked with her chair. Appt. Book then
 *   shows that chair as "Removed from team" with Move appointments for the
 *   owner (reassignChair), which is the app's own way to hand them on.
 *
 * Once per database: the comment on stylists.removed_at is the marker, set in
 * the same block. Without it, re-adding a stylist called Micah later (the
 * slug is kept on revival) would be undone on the next cold start.
 */
export const MICAH_REMOVED_MARK = 'When the stylist left the team. Micah Shadle removed 2026-11-23.';

export const REMOVE_MICAH_ONCE = `DO $$
DECLARE
  t uuid;
  chair uuid;
  login uuid;
BEGIN
  PERFORM set_config('lock_timeout', '3s', true);
  IF col_description('stylists'::regclass,
       (SELECT attnum FROM pg_attribute WHERE attrelid = 'stylists'::regclass AND attname = 'removed_at'))
     IS NOT DISTINCT FROM '${MICAH_REMOVED_MARK}' THEN
    RETURN;
  END IF;
  SELECT id INTO t FROM tenants WHERE slug = 'synergy';
  IF t IS NOT NULL THEN
    SELECT id, staff_user_id INTO chair, login FROM stylists WHERE tenant_id = t AND slug = 'micah';
    IF login IS NULL THEN
      SELECT id INTO login FROM staff_users
       WHERE tenant_id = t AND lower(btrim(name)) = 'micah shadle'
         AND role NOT IN ('owner', 'admin')
       LIMIT 1;
    END IF;
    UPDATE stylists SET active = false, removed_at = coalesce(removed_at, now()), photo = NULL
     WHERE tenant_id = t AND (slug = 'micah' OR (login IS NOT NULL AND staff_user_id = login));
    IF login IS NOT NULL THEN
      BEGIN
        UPDATE services SET active = false WHERE tenant_id = t AND owner_staff_id = login;
      EXCEPTION WHEN undefined_column THEN NULL;   -- before 045: nothing of hers alone
      END;
      BEGIN
        DELETE FROM staff_users WHERE id = login AND tenant_id = t;
      EXCEPTION WHEN foreign_key_violation THEN
        RAISE NOTICE 'Micah''s login is still referenced; left in place';
      END;
    END IF;
  END IF;
  COMMENT ON COLUMN stylists.removed_at IS '${MICAH_REMOVED_MARK}';
END $$`;
