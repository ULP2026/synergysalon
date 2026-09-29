-- Profiles: the person, and the business.
--
-- Two additions that the console has needed since it stopped being one
-- salon's private tool.
--
-- Avatars and logos are stored in the row rather than in object storage. They
-- are resized to 256px in the browser before they are sent, which puts them
-- at a few tens of kilobytes -- small enough that a bucket, its credentials,
-- its lifecycle rules and its own failure modes cost more than they save. If
-- they ever stop being small, the column becomes a URL and nothing else moves.
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS avatar text;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS phone text NOT NULL DEFAULT '';

-- What a shop tells its customers. Separate from the operational columns
-- (timezone, host, CRM credentials) because an owner edits these and should
-- never be near those.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS logo        text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS address     text NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS phone       text NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS email       text NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS website     text NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS about       text NOT NULL DEFAULT '';
