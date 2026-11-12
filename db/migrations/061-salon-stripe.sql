-- The salon's own Stripe account, linked with "Connect with Stripe"
-- (Synergy App 1.0, asked for 2026-11-13). Only the account's id is kept,
-- never a key: the app's platform key with this id (Stripe-Account) is how
-- the salon's saved cards and no-show fees will live in the salon's Stripe.
-- 061 because the unshipped step1-leftovers branch holds 059 and 060.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_account_id text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_livemode boolean;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_connected_at timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_connected_by uuid;
