-- Micah Shadle off the team (2026-11-23): what "Remove from team" does,
-- once per database. The comment on stylists.removed_at is the marker.
-- api/_lib/former-stylists.js holds the same statement, which ensure-schema runs.
DO $$
DECLARE
  t uuid;
  chair uuid;
  login uuid;
BEGIN
  PERFORM set_config('lock_timeout', '3s', true);
  IF col_description('stylists'::regclass,
       (SELECT attnum FROM pg_attribute WHERE attrelid = 'stylists'::regclass AND attname = 'removed_at'))
     IS NOT DISTINCT FROM 'When the stylist left the team. Micah Shadle removed 2026-11-23.' THEN
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
  COMMENT ON COLUMN stylists.removed_at IS 'When the stylist left the team. Micah Shadle removed 2026-11-23.';
END $$;
