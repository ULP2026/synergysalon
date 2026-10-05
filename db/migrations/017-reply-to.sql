-- Where guests' replies go.
--
-- Confirmation and reminder emails were sent with the salon profile's email as
-- their reply-to, so a guest answering "can I move this to 3?" reached
-- whatever address the website prints. Team Settings now asks for the inbox
-- the team actually reads. Empty falls back to the profile email, as before.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS reply_to text;
