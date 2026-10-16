-- Admin as a role of its own.
--
-- The salon's one admin rule (canManageTeam: change anybody's account, set
-- hours, connect calendars for others) used to belong to the Owner role, so
-- the person running the app day to day had to be made an owner to do it.
-- Admin gives the same rights without the title. Like an owner, an admin runs
-- the place rather than taking appointments: no services, prices or hours.
-- ADD VALUE cannot be undone or run inside a transaction block, which is why
-- it is alone in this file.
ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'admin';
