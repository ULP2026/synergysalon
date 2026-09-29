-- A private calendar feed per stylist.
--
-- Stylists carry their own phone, not the front desk's screen, and asking
-- somebody to open a web console to find out when their next client arrives
-- is how a salon ends up with two diaries again. A subscription URL puts the
-- salon's diary inside whatever calendar they already use.
--
-- The token is the credential: anybody holding the URL can read that
-- stylist's day, so it is long, random, and regenerable without touching the
-- appointments themselves.
ALTER TABLE stylists ADD COLUMN IF NOT EXISTS calendar_token text;

UPDATE stylists
   SET calendar_token = replace(gen_random_uuid()::text, '-', '')
                     || replace(gen_random_uuid()::text, '-', '')
 WHERE calendar_token IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS stylists_calendar_token
  ON stylists (calendar_token) WHERE calendar_token IS NOT NULL;
