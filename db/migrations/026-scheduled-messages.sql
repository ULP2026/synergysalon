-- The queue every automation after the first four needs.
--
-- M1 to M3 fire at the moment something happens, so they send inline. Almost
-- everything in the catalog from M4 down is "send this in three hours" or
-- "send this in ten days", and nothing in the app could express that: the
-- only scheduled thing was the reminder, and it was a single boolean
-- (appointments.reminder_sent_at) that answers one question about one
-- message.
--
-- So: a row per message waiting to go out. A trigger writes rows here, a
-- daily cron drains the ones that are due, and anything that makes a message
-- pointless (the guest rebooks, the appointment is cancelled) cancels the
-- rows rather than deleting them, so the reason is still readable afterwards.
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind           text NOT NULL,
  -- Both optional: a win-back is about a person with no appointment, and a
  -- no-show chase is about an appointment. CASCADE on both, because a queued
  -- message to a deleted guest must not go out.
  appointment_id uuid REFERENCES appointments(id) ON DELETE CASCADE,
  contact_id     uuid REFERENCES contacts(id) ON DELETE CASCADE,
  to_name        text,
  to_email       text NOT NULL,
  -- Due, not exact. The cron runs once a day on Vercel's Hobby plan, so a
  -- row due at +3 hours goes out on the next pass and may be up to a day
  -- late. Writing the real intent here rather than rounding it means the
  -- timings become accurate the moment the plan allows an hourly cron,
  -- without touching a single trigger.
  send_after     timestamptz NOT NULL,
  sent_at        timestamptz,
  cancelled_at   timestamptz,
  cancel_reason  text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- What the drain asks for: this salon, due now, not yet sent, not cancelled.
CREATE INDEX IF NOT EXISTS scheduled_messages_due
  ON scheduled_messages (tenant_id, send_after)
  WHERE sent_at IS NULL AND cancelled_at IS NULL;

-- Cancelling by contact is how "stops when they book again" is implemented.
CREATE INDEX IF NOT EXISTS scheduled_messages_contact
  ON scheduled_messages (contact_id)
  WHERE sent_at IS NULL AND cancelled_at IS NULL;

-- One of each kind per appointment, so a trigger that runs twice -- a double
-- click, a retried webhook -- cannot queue the same email twice. Partial, so
-- a cancelled run can be re-queued later if the guest rebooks.
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_messages_once
  ON scheduled_messages (appointment_id, kind)
  WHERE appointment_id IS NOT NULL AND cancelled_at IS NULL;

-- How often a service is normally repeated, in days: the due date M9 and M10
-- count from. Null means "no natural interval" (a one-off treatment), and
-- those services queue no rebook reminder at all rather than inventing one.
ALTER TABLE services ADD COLUMN IF NOT EXISTS rebook_days integer;

-- Where the review request sends people. Null until the salon sets it, and
-- M8 queues nothing while it is null: an email asking for a review with no
-- link to leave one is worse than no email.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS review_url text;
