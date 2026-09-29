-- Whether a calendar is really connected.
--
-- A subscribed feed has no handshake: Google and Apple fetch the URL from
-- their own servers on a timer and never tell us anybody subscribed. So a
-- "Connected" badge cannot be set when the button is pressed -- at that point
-- nothing has happened yet, and saying otherwise would be a green light that
-- means "you clicked a link".
--
-- What can be known is that somebody's calendar service came and read the
-- feed, when, and usually which one from the user agent. That is the real
-- signal, and it is the one shown.
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS calendar_last_fetch timestamptz;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS calendar_fetches integer NOT NULL DEFAULT 0;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS calendar_last_agent text;
