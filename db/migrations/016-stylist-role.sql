-- Stylist as a role of its own.
--
-- Everybody on the team was an owner, a manager or front desk, so a stylist
-- had to be entered as front desk. The Clients page now offers one filter per
-- stylist, and "front desk" cannot tell it who those are.
--
-- A stylist has front desk's access: the diary and the client list, never the
-- team or the salon's settings. ADD VALUE cannot be undone or run inside a
-- transaction block, which is why it is alone in this file.
ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'stylist';
