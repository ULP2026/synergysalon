/**
 * Reading a Google Calendar from its private iCal address: what counts as
 * busy on one salon day. Runs without a database or network; fetch is
 * replaced with the feed below.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { icsBusyBetween, parseIcsLink, readIcsLink } from '../api/_lib/google-ics.js';

const ZONE = 'America/New_York';
const NY = `BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
TZNAME:EDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
TZNAME:EST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE`;

const ev = (body) => `BEGIN:VEVENT\n${body}\nEND:VEVENT`;
const FEED = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', NY,
  // A plain hour on the day, in New York time.
  ev('UID:one\nDTSTART;TZID=America/New_York:20261005T093000\nDTEND;TZID=America/New_York:20261005T110000\nSUMMARY:Dentist'),
  // In UTC.
  ev('UID:utc\nDTSTART:20261005T180000Z\nDTEND:20261005T190000Z\nSUMMARY:Call'),
  // "Show me as available": not busy.
  ev('UID:free\nDTSTART;TZID=America/New_York:20261005T120000\nDTEND;TZID=America/New_York:20261005T130000\nTRANSP:TRANSPARENT'),
  // Cancelled: not busy.
  ev('UID:gone\nDTSTART;TZID=America/New_York:20261005T140000\nDTEND;TZID=America/New_York:20261005T150000\nSTATUS:CANCELLED'),
  // The next day: not today.
  ev('UID:tomorrow\nDTSTART;TZID=America/New_York:20261006T100000\nDTEND;TZID=America/New_York:20261006T110000'),
  // Every Monday at 4pm since January, with this Monday's moved to 5pm.
  ev('UID:weekly\nDTSTART;TZID=America/New_York:20260105T160000\nDTEND;TZID=America/New_York:20260105T163000\nRRULE:FREQ=WEEKLY;BYDAY=MO'),
  ev('UID:weekly\nRECURRENCE-ID;TZID=America/New_York:20261005T160000\nDTSTART;TZID=America/New_York:20261005T170000\nDTEND;TZID=America/New_York:20261005T173000'),
  // All day, busy.
  ev('UID:allday\nDTSTART;VALUE=DATE:20261005\nDTEND;VALUE=DATE:20261006\nTRANSP:OPAQUE'),
  'END:VCALENDAR',
].join('\r\n');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const LINK = 'https://calendar.google.com/calendar/ical/zz.stylist%40gmail.com/private-abc123/basic.ics';

test('a day of a Google Calendar, as busy times only', async () => {
  globalThis.fetch = async () => new Response(FEED, { status: 200 });
  const busy = await icsBusyBetween(LINK, '2026-10-05T04:00:00.000Z', '2026-10-06T03:59:59.999Z', ZONE);
  assert.deepEqual(busy, [
    { allDay: true, startsAt: '2026-10-05T04:00:00.000Z', endsAt: '2026-10-06T04:00:00.000Z' },
    { allDay: false, startsAt: '2026-10-05T13:30:00.000Z', endsAt: '2026-10-05T15:00:00.000Z' },
    { allDay: false, startsAt: '2026-10-05T18:00:00.000Z', endsAt: '2026-10-05T19:00:00.000Z' },
    { allDay: false, startsAt: '2026-10-05T21:00:00.000Z', endsAt: '2026-10-05T21:30:00.000Z' },
  ]);
  // Nothing but times comes back.
  assert.ok(busy.every((b) => Object.keys(b).join() === 'allDay,startsAt,endsAt'));
});

test('only Google Calendar iCal addresses are accepted', () => {
  assert.deepEqual(parseIcsLink(LINK), { url: LINK, account: 'zz.stylist@gmail.com', isPrivate: true });
  assert.equal(parseIcsLink('https://evil.example/calendar/ical/a/private-b/basic.ics'), null);
});

test('what people actually paste is fixed or answered', () => {
  // Forgivable: quotes, spaces, webcal://, http://, no scheme, text around it.
  for (const pasted of [` "${LINK}" `, LINK.replace('https://', 'webcal://'), LINK.replace('https://', 'http://'),
    LINK.replace('https://', ''), `My calendar: ${LINK} thanks`]) {
    assert.equal(readIcsLink(pasted).url, LINK, pasted);
  }
  // Mistakes, each with its own answer.
  assert.match(readIcsLink('zz.stylist@gmail.com').reason, /calendar ID/);
  assert.match(readIcsLink('https://calendar.google.com/calendar/embed?src=zz.stylist%40gmail.com').reason, /viewing the calendar/);
  assert.match(readIcsLink('https://calendar.google.com/calendar/ical/zz.stylist%40gmail.com/private-abc').reason, /cut short/);
  assert.match(readIcsLink('https://outlook.office365.com/owa/calendar/x/reachcalendar.ics').reason, /not a Google Calendar/);
  assert.match(readIcsLink('').reason, /Paste/);
});
