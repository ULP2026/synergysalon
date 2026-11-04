-- Why a connected Google account cannot be read, when Google says so
-- (asked for 2026-11-04, after Dina's connection read as Connected while
-- every read of it failed with 403 notACalendarUser: the Google account she
-- signed in with had never set up Google Calendar). 'no_calendar' for that;
-- NULL once a read works again. The console shows it as "Needs attention".
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS google_problem text;
