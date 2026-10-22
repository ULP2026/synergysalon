-- Tickets, and how each client wants to be contacted.
--
-- Additive only: two kinds of new column, nothing existing altered or
-- dropped, and no rows written. NOT in api/_lib/ensure-schema.js, so it never
-- runs by itself on the live database; it runs only by a deliberate
-- npm run db:migrate once it is approved, alone, with the usual proof posted
-- on the card. The code reads these columns through to_jsonb and checks they
-- exist before writing them, so the app behaves exactly as before until then.
--
-- Numbered 031 on purpose: 028 is reserved for chair applications, and 029
-- and 030 are left for the approved email_unsubscribes and paid flag
-- migrations, which may land first.

-- The services of one visit, itemized. An appointment row has one service_id
-- and the visit total in price_cents; a visit of several services was booked
-- end to end (combineServices in availability.js) but only the first service
-- was remembered. This keeps every line as it was priced when booked:
-- [{"slug": "...", "name": "...", "priceCents": 6500, "durationMin": 60}].
-- A snapshot, like price_cents, so re-pricing a service later does not
-- rewrite an old ticket. NULL for appointments made before it existed.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS services jsonb;

-- Whether this client may be sent follow-up emails, and texts, by the app.
-- Separate, because people often want one and not the other. Defaults to
-- yes, which is what happens today for everybody.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_ok boolean NOT NULL DEFAULT true;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sms_ok boolean NOT NULL DEFAULT true;
