-- Payroll through Stripe (asked for 2026-11-05).
--
-- A stylist's cash out is now a real Stripe Connect transfer from the
-- salon's Stripe balance to the stylist's own Express account, which Stripe
-- then pays to their bank. stripe_account_id is that account ("acct_..."),
-- made the first time they connect from Settings, Money, Payroll. Nothing
-- else about their bank is ever stored here: Stripe holds it.
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS stripe_account_id text;

-- A cash out is 'processing' from the moment it reserves the money (so two
-- taps, or two tabs, cannot spend the same balance twice) until Stripe has
-- answered and the transfer has been read back; then 'paid', or 'failed'
-- with Stripe's reason, which gives the money back to the balance.
-- 'requested' and 'declined' are the manual requests from before Stripe.
ALTER TABLE cashout_requests ADD COLUMN IF NOT EXISTS stripe_transfer_id text;
ALTER TABLE cashout_requests ADD COLUMN IF NOT EXISTS error text;
ALTER TABLE cashout_requests DROP CONSTRAINT IF EXISTS cashout_requests_status_check;
ALTER TABLE cashout_requests ADD CONSTRAINT cashout_requests_status_check
  CHECK (status IN ('requested', 'processing', 'paid', 'failed', 'declined'));
