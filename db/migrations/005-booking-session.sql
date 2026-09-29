-- Give a booking session its own identity.
--
-- /api/enquiry is called as the guest types, and until now it worked out who
-- they were from whatever was in the email box at that instant. Half an email
-- address is a different string from a whole one, so "sup", "support" and
-- "support@example.com" each looked like a new person: five contacts and four
-- appointments from one guest booking once.
--
-- The wizard now mints an id when it opens and sends it with every call, so
-- every post in one sitting resolves to one contact no matter how the typing
-- evolves. Email and phone remain the fallback, which is what matches a
-- returning guest to the record they already have.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS session_id text;

CREATE INDEX IF NOT EXISTS contacts_session_idx
  ON contacts (tenant_id, session_id)
  WHERE session_id IS NOT NULL;
