# Synergy Salon: working notes

Read `README.md` first: it is the PMC, the client's brand and business record,
and it governs what may be said on the site. This file covers the code.

## What this repo is

The public site for a hair salon in Valrico, Florida, plus a booking system
and a staff console.

```
synergysalon.com          the public site (static HTML)
app.synergysalon.com      the staff console (same project, host-based routing)
join.synergysalon.com     Rent a Chair landing (separate Vercel project, root: join/)
```

Hosted on Vercel from one repo, two projects. `vercel.json` does host-based
redirects; `.vercelignore` must not exist, because it applies to every project
built from the repo and once emptied the join deployment.

## join.synergysalon.com

`join/index.html` is a bundle like the main pages, served by its own Vercel
project (root `join/`), so anything it loads must be under `join/assets/`.
Its header is the main site's (util strip, bar with in-page links, burger and
drawer, same CSS values), and it runs the main site's Lenis on the GSAP
ticker (the same three files, copied). Behaviour lives in the page's own
`text/x-dc` component, `joinMount()`, as plain DOM: the page never
re-renders, and a setState would redraw the template and drop the
transforms. The hero sits in a 150vh `.hero-pin`; the panel is sticky and
scales by `1 - k * p(2 - p)` (k .42 from 1180px, .10 from 768px, off below
768 and for reduced motion), and `#tour` has no sheet of its own: it is the
page, pulled up by exactly what the shrunk hero gives back (74k vh), so it
follows the hero with no band and no overlap. The fold is the main site's
hero (badge and title centred, chair centred and rising into the title's
last line, placed by `placeChair` as on the main site; details along the
foot). Images below the fold open from an inset frame as they scroll in
(GSAP ScrollTrigger, scrubbed, off for reduced motion). From 1180px, with motion allowed, two salon photos per side
(`.fold-gal`, a sticky layer behind the panel) slide out from behind the card
as it shrinks, laid out as the Legacy home page's: two equal portrait cards a
side, 18px apart, a little lower than the card. The tour section has no side
photos (removed on request). The black footer is
the only footer; the old gray one was removed on request. Book a Salon Tour
lands the whole form in view, counting the phone's bottom bar. It opens with
the main site's loader, copied beat for beat (SYNERGY, the three-picture
window, the card growing into the fold, then chair, header, headline, foot):
`html.js-anim` is armed in the template head, `playIntro()` runs it, and it
is skipped for reduced motion or when the page opens part way down. While
it runs the hero is `position:relative` (`.rc.intro`), because sticky
always makes a stacking context and would keep the card under the loader.
Type follows the main site's measured scale: labels 14px/500 untracked, the
fold headline as its h1, the fold paragraph as its hero lede, paragraphs
16px/1.5, small titles and FAQ questions 20px/500. The GoHighLevel iframe,
its embed script and the thank-you message listener are untouched.

## The pages are design-tool exports

`index.html` and the four service pages are single-file bundles from a design
tool. A bundle holds:

- `<script type="__bundler/manifest">`: base64 assets, some gzipped
- `<script type="__bundler/template">`: the whole page as a JSON string
- a loader that mints blob URLs and calls `documentElement.replaceWith()`

Two consequences that have each cost a day:

**A script inside the template never executes.** The parser only runs scripts
it parsed itself, and `replaceWith()` does not count. Anything that must run
(tracking, the booking adapter) goes in the *static* `<head>`, binds to
`document` or `window` (both survive the replacement), and delegates its
handlers. This is not obvious locally, where it can appear to work.

**Every export drops what is not in the design source.** GA4, canonical,
description, Open Graph, favicons, real reviews, and every link fix. When a new
export arrives, re-apply them.

**And it restores what was deleted from the design.** On 2026-10-15 the CENTRO
booking iframe was removed from `index.html` and `hair-salon-riverview.html`,
but it sat *inside* the template -- inside the design itself, not beside it in
the static head. Unless it is also deleted in Claude Design, the next export
brings it back, and silently: the template is one escaped line nobody diffs by
eye, so the first sign would be guests booking into a calendar this app cannot
see. After any new export, check with `grep -c leadconnectorhq *.html` and
expect zero. There are scripts for this pattern in the
scratchpad of whichever session wrote them; the shape is: unpack → re-apply →
externalise assets → re-fix links.

**Brandon, FishHawk and the AI Scalp Analysis page are copies of Riverview**
(built 2026-11-02 on request, after the salon's hold on the town pages ended
on 2026-10-20). Each is the Riverview bundle with its own head, schema,
static text, hero and the block inside `.svp-riverview`; the internal page key
stays `riverview`, because the shared CSS and the map are keyed on it, so
those class names are not a mistake. They have no design source of their own:
a new Riverview export does not update them, and changing them means editing
the copy, not Claude Design. Drive times are OpenStreetMap routes without
traffic (Brandon Blvd and Kings Ave 9 min, Westfield Brandon 13, FishHawk
Ranch 12; the same tool gives Riverview 14 against the page's 15). Every page's
footer links all three, and the Services menu's "AI Scalp Analysis" opens the
scalp page rather than the treatments page's anchor.

**The Schedule section's photo** was a 4032x3024, 2.4 MB phone JPEG
(`2b1e0a12…jpg` on the home and Riverview pages, a byte-identical
`82e0ffb4…jpg` on the service pages) loaded on every page before any
scrolling. It is now `ff5219db…webp`, 2400 px and 279 KB, with
`loading="lazy"`; the Kim and Micah portraits moved to WebP the same day. An
export brings the JPEGs back: after one, `grep -l "2b1e0a12\|82e0ffb4" *.html`
should find nothing. The old files stay in `assets/` because
`api/_lib/stylist-photos.js` serves the portraits to the console.

Exports also reference files by their name in the design tool
(`uploads/images/x-team-dina.webp`, `Color Services.html`). None of those are
published. Repoint them at `/assets/<uuid>` or the real routes, and check every
`#anchor` still exists on the page it now lands on.

## Booking

Postgres owns the diary. **Nothing is sent to CENTRO (GoHighLevel) any more**
(asked for 2026-10-21): no client records, and so no bookings, moves,
cancellations or status changes either, since CENTRO only takes an
appointment attached to a contact. `api/_lib/ghl.js` can only read (a
stylist's free time, the calendar's slot length, whether the link works);
every function that wrote was removed rather than switched off, and
`tests/ghl.test.js` fails if one comes back or if anything in `api/` queues a
`sync_outbox` job again. The table stays as the record of what was sent
before the switch-off: the client timeline still shows "Synced to the CRM"
for those, and nothing reads its pending rows. Bookings made before then
that are in CENTRO stay there unchanged; a move or cancellation here no
longer reaches them. If anyone books in CENTRO's own calendar, the two
diaries do not know about each other and double-booking returns.

The booth-rental page (`join/index.html`) is separate and still embeds a
GoHighLevel form, so stylists applying for a chair go into CENTRO directly
from the browser. Those are applicants, not salon clients, and the switch-off
did not touch it.

**Double-booking is prevented by the database, not by code:**

```sql
EXCLUDE USING gist (stylist_id WITH =,
  appointment_blocks(starts_at, upper(during), breaks) WITH &&)
WHERE (status <> 'cancelled')
```

(Until 2026-10-17 it compared `during` whole; it now leaves out a color's
processing breaks, below.)

Checking availability before inserting cannot work on its own: two requests
both read "free" before either writes. `tests/booking.integration.test.js`
proves the constraint by running the race.

The homepage wizard is a design-tool component with **no backend of its own**.
As shipped it collected seven steps and discarded them, and its calendar was
invented: a hash of the date and stylist name kept 42% of slots. The adapter in
the static head reads the rendered DOM, posts to `/api/enquiry`, and replaces
the fake availability with the real diary.

The survey (same code in all nine pages, Riverview and its three copies included) is: 1 the kinds of service (Color,
Cuts, Treatments, Styling, AI Scalp Analysis, "Select all that apply" as a
pill), 2 stylist, 3 who it is for, 4 service details (one question per kind
picked; the scalp analysis is a details card), 5 availability, 6 name, email,
phone and optional notes with "Book Me Now!" (the confirmation, redesigned
2026-10-16: "You're booked, <first name>!" over "Your appointment is set for
**<day>** at **<time>**", then the details on the left (`bkSummary`: service,
For, which reads as the guest's own name for "Myself", date and time, phone,
location) beside a card for the stylist on the right (`bkWho*`: their portrait
from `bkTeam`, else initials; the service row is set larger, `bk-svc`), the one the server actually booked
(`stylist` in `/api/enquiry`'s reply, passed through `ss-bk-result` as
`bookedWith`) so "First available" shows a real person. It fits without
scrolling down to 375x667: short screens drop the date row, which repeats the
line under the title (`bk-dup`), and phones keep the "How did you hear" chips
on one sideways-scrolling row; stylist moved to step 2 on
request, 2026-10-15, by remapping `bkS2`..`bkS4` and `bkCan` in the
template's logic; the design source still has the old order, so a new export
undoes it until it is changed in Claude Design too), then a confirmation with
confetti, a six-second "Appointment booked!" toast, and an optional "How did you hear about us?". The popup publishes its
answers on `window.__ssBk`; the adapter reads them there (not from headings),
answers `ss-bk-confirm` with `ss-bk-result`, and the popup says "booked" and
throws confetti and the toast only when the reply has a ref. There is no redirect to
`/thank-you` any more. The confirmation's first button is **Add to my
Calendar** (2026-11-07, all nine pages with the popup): `/api/enquiry`
replies with `calendar`, the confirmation email's own Google Calendar link
(`calendarUrl` in `email.js`), passed through `ss-bk-result` as `calUrl`
and shown only for a booking (`bkHasCal`); its class is `bk-addcal`, since
`bk-cal` is the availability calendar's. Details save as they are typed, so
the booking is usually made just before "Book Me Now!", whose own request
finds it already there: the reply looks that booking up (`bookingByRef`) so
the stylist and the link still come back. Returning guests are filled in only from what this
browser saved at their last booking (`ss-guest` in `localStorage`, matched on
the typed name): looking a profile up by name on a public page would expose
any client's email and phone. Color's "Other" has no service, so it saves a
lead for the salon to call, as "Not sure yet" did.

**Phone polish for the popup** (2026-10-22) lives in the booking script of
all nine pages' static heads, as a `<style id="ss-bk-polish">` put back into
the page whenever it is missing (a static `<style>` is thrown away when the
bundle swaps its document in): on touch screens a card looks picked only
when it is (`@media (hover: none)`, the tap that opens the popup used to
leave a sticky hover on the card under it), the day's label has room above
its times (space under the calendar), and "Get directions" and "Done" share the row on one line each.
The "coming soon" notice's panel counts its padding in its width
(`box-sizing:border-box`, 2026-10-22): before, it was 414px wide on a 390px
phone and ran off the right edge, the only thing a guest saw on tapping Book.
While the popup is open the test-mode bar sits at the top of the screen;
at the bottom it covered Continue and a tester could not leave step 1.

**Test mode on the Vercel addresses.** `?booking-demo=1` on a `*.vercel.app`
(or local) address opens the real popup despite the pause, with a yellow
"Test booking mode: bookings are real and show in the app" bar. Since
2026-10-16 it **saves for real**: it used to answer "Book Me Now!" with a
made-up booking, and the salon tested a booking and then could not find it in
the app. The server lets it through because `previewAllowed` (preview.js) also
accepts any request whose Host is `*.vercel.app`: those addresses are behind
Vercel's login, and only this project's deployments receive them. If
deployment protection is ever switched off they are as open as a live site.
Preview deployments share the live `DATABASE_URL`, so a test there is a real
appointment too: name test guests ZZ and delete them. The flag is ignored on
the salon's own domain. The survey offers dates from tomorrow; the adapter now
leaves closed any date the survey marks "unavailable" (today, the past, past
six weeks) even when the server has times on it, because it showed today as
live and then could never list a time.
**The test link to send** is the production deployment's own address
(`synergysalon-<hash>-support-2531s-projects.vercel.app/?booking-demo=1`,
with a Vercel share token since the project's `*.vercel.app` addresses are
behind Vercel login), not a preview: only Production has `TOKEN_KEY` and
the Google client, so on a preview every stylist who signed in with Google
is offered no times (fail closed), which read as "this stylist has no open
times this month". `DEFAULT_TENANT=synergy` was added for Production on
2026-10-15 so that address finds the salon.
Previews also need `DEFAULT_TENANT=synergy` (set for Preview on 2026-10-14):
a `*.vercel.app` host matches no salon, so before it every `/api/` call there
answered "No salon is configured for this address" and the popup listed nobody.
`TOKEN_KEY` and the Google client are Production only, so a preview cannot read
anyone's Google Calendar: a connected stylist is listed there but offered no
times (fail closed). Add those three to Preview to test Google end to end.

`/api/enquiry` saves the contact *before* attempting the appointment, and books
whenever it has a service and a time rather than waiting for the wizard to say
it finished; that signal failed four separate ways. Because it is called on
every keystroke, it also refuses to create a second appointment for a guest who
already has one.

**Identity comes from the session id, not from the email box.** The wizard
mints an id when it opens and sends it with every call; the server resolves the
contact from that first and falls back to email or phone. Keying on the email
alone meant every prefix of an address looked like a new person: one guest
booking once produced five contacts and four appointments, and every prefix
was then rejected by CENTRO with a permanent 422, which killed the appointment
push attached to it. A detail is only stored or sent once it is whole: a
half-typed address is not a worse email, it is not an email yet.

The console says nothing about syncing: the "Not synced yet" and "Sync
failed" chips, the Home note about today's bookings and the "here and in the
CRM" wording on deletes all went with the push. `/api/cron/sync` keeps its
path and schedule and now only catches up stylists' Google copies.

**The Synergy Calendar is this database.** Availability is built from
`stylist_hours`, `time_off` and `appointments` here (`api/_lib/availability.js`),
for guests and staff alike. **Online, only stylists who have connected a
Google Calendar are offered at all** (the salon's rule, 2026-10-14): one
added to the app without it is left out of `/api/services` (the survey's
stylist step and the shop page), refused by `/api/availability` with "not
taking online bookings yet", and so refused by online `createBooking` too.
Their services and prices are untouched and they reappear the moment they
connect. `GOOGLE_CONNECTED_SQL` in `google-busy.js` is the one test, signed
in or pasted address. The exception is the salon's four current stylists
(Dina, Micah, Tami, Kim: `GOOGLE_OPTIONAL_STYLISTS` in `config.js`, by
slug), kept on request: they are offered from their Synergy Calendar hours
alone until they connect, then Google takes its busy time out as for anyone.
Empty that list once all four have connected. The desk still books anyone. Google only ever takes
time away: for guests (`google: true`
on the public paths: `/api/availability`, `/api/enquiry`, `/api/book`
through `createBooking` with `channel: 'online'`, and the guest's own
reschedule) a connected stylist's Google busy times are subtracted
(`api/_lib/google-busy.js`, cached a minute), and a stylist whose calendar
cannot be read is offered nothing online (fail closed, chosen by the salon).
The desk is not limited by Google. Bookings are copied into the stylist's
Google Calendar for stylists who signed in with Google (`google-mirror.js`,
run after every booking or change and again by the daily cron; a pasted address is
read-only), and their copy is removed before an appointment is deleted.
The copies go into **the person's main Google calendar** (since 2026-11-06,
asked for: "merge the app and website calendar so Dina sees only one
calendar in Google"). From 2026-10-14 until then they went into a calendar
the app made, named after the salon, which in hair@synergysalon.com (an
account itself named Synergy Salon) showed as a second "Synergy Salon".
`salonCalendarFor` now always answers `'primary'` and makes nothing;
`staff_users.google_calendar_id` is `'primary'`. Anyone still holding a
calendar the app made is moved by `mergeIntoMain` (google.js), which the
daily `/api/cron/sync` runs first: it deletes that calendar in one call
(allowed by `calendar.app.created`, which reaches only calendars the app
made; event by event if that fails), drops those `google_events` and
`google_blocks` rows, remakes the copies of future lunches and blocks, and
the mirror then copies every booking afresh into the main calendar. Each
copy still records its calendar (`google_events.calendar_id`, 020).
Busy time is read from the main calendar, and the app's own copies there,
bookings (`google_events`) and lunches and blocks (`google_blocks`), are
skipped by id: read back as busy, they stopped a guest moving their own
appointment. `calendar.app.created` is still requested on connect, only so
an old calendar can be removed; it can go once nobody has one.
The guest's own reschedule and cancel update the Google copy at once
(`api/appointment.js`) instead of waiting for the cron.

**Several services are one appointment.** The survey's other services go to
the server (`body.services` on `/api/enquiry`, `&with=` on
`/api/availability`) and are booked as one appointment with one stylist who
offers every one: the guest's time is all of them end to end with the
clean-downs between, the last clean-down after (`combineServices`), priced
only when every part has a price. Moving it keeps its own length and breaks
(`length` on `availableSlots`).

**A booking is as long as the stylist says the work takes** (asked for
2026-10-17). Each stylist's own figures in their team window (Duration per
kind; for Color, Start, Break and Finish, once for Color and once for
Highlights) decide the length of what is booked with them
(`api/_lib/timing.js`, `timedService`); the services table's
`duration_min` (industry estimates, still owed by Dina) is used only where
the stylist typed nothing. One figure covers the whole kind, so a stylist's
Cuts time is also their bang trim's. Highlights times every color service
whose slug or name says highlight, balayage or foil. Color & Cut is the
cut first, then the Color parts (asked for 2026-10-20: cut 45, apply 45,
process at least 45 with the stylist free, finish 45, `COLOR_AND_CUT` in
`timing.js`); those 45s stand in for any figure the stylist has not typed,
and the break is never shorter than 45. Single Process Color is the same
without the cut (45/45/45, 135 minutes in place of the table's 90). A cut booked alongside a color as
separate services also goes first (`combineServices`). Lengths differ per stylist, so
`availableSlots` returns `visits` (stylist id to visit) and `createBooking`
books each stylist tried at their own length.

**Processing breaks free the stylist** (2026-10-17). A color's Break is
stored on the appointment as `breaks` (`[[minutes from start, minutes
long]]`, relative, so every `UPDATE ... starts_at` carries it along), and
the no-overlap rule is now `appointments_no_overlap_blocks`:

```sql
EXCLUDE USING gist (stylist_id WITH =,
  appointment_blocks(starts_at, upper(during), breaks) WITH &&)
WHERE (status <> 'cancelled')
```

`appointment_blocks()` is the appointment's range with its breaks cut out
(migration 025, also in ensure-schema, which adds the new constraint before
dropping the old so there is never a moment without one; needs Postgres 14+
for multiranges). Availability subtracts only the working parts of existing
bookings (`workSpans`), a salon closure still stops the whole visit, and
Google busy time must miss only the parts the stylist works. Appt. Book
draws such an appointment as its Start card, a dashed "Processing · free"
band the pointer passes through (click it to book into the break), and a
Finish card; the appointment window lists the processing times.
`tests/processing-breaks.integration.test.js` proves both the offer and the
constraint.

**The website survey reads the Synergy Calendar, for real now.** Three bugs
meant it never had: the adapter's MutationObserver watched
`document.documentElement`, which the page replaces as it loads, so it never
fired; its first early return never released its busy flag; and when the
server had nothing to offer it left the survey's invented calendar showing.
It now observes `document`, always hands back, and fails closed (every day
shut, with the server's reason under the calendar). The survey offers a wide
grid (every day, 8 to 9, its 42% random "taken" hash turned off) and the
adapter hides every time the calendar cannot honour. The stylists come from
`/api/services` (only those with a service on and a Google Calendar
connected, with their portraits) as the page mounts and again when the popup
opens (`bkLoadTeam`, published on `window.__ssBkTeam`); the adapter maps a
name to a slug through that, the old fixed map only as a fallback. Since
2026-11-03 the popup's stylists are exactly the app's (names, titles and
pictures from `/api/services`); `bkCore`, the old fixed four, is only what
shows until that answer arrives, or if it never does. A stylist picked from
a team card who is not in the list is dropped when it arrives. The
confirmation writes the guest's phone as the salon writes its own
(813.555.0199) and the address in full (3212 Lithia Pinecrest Rd, Suite
101, Valrico, FL 33594), as the PMC has them.

**The guest's manage page** is `/appointment?ref=…&t=…` (`appointment.html`),
linked from every email: details, "Choose a new time" (the next four weeks
from `GET /api/appointment?…&from=&to=`, same stylist, same length, same
rules as booking) and "Cancel appointment". It did not exist before; the
email links led nowhere.

It used to be asked of CENTRO, which meant a stylist with no CENTRO user
linked was offered nothing at all. All four were in exactly that state, which
is why online booking was switched off: there was nobody left to offer. A
salon that has never heard of CENTRO can now take bookings, which is the whole
point of selling this to a second customer.

`api/_lib/centro-hours.js`, `freeSlots` in `ghl.js` and the `centro` flag on
`availableSlots` are dead as of `c8ed305`. Every caller passes `false`.
Removing them is a tidy-up, not a behaviour change. Linking a stylist to a
CENTRO user is no longer needed for anything.

**The team is the only list.** Anyone with one of the four service switches on
is bookable: saving them creates or revives a `stylists` row linked by
`staff_user_id`, maps the switches to `services` by `category` (the four
switches and the four categories are the same four things), and writes their
weekly hours (`api/_lib/roster.js`). Turning every switch off deactivates the
row rather than deleting it, because appointments point at it and past work
has to keep its name. Reviving keeps the original slug, so old booking links
still work.

The console used to show a team while the booking engine read a separate
`stylists` table maintained by hand in SQL. Nobody was told the second list
existed, which is how every stylist ended up deactivated.

**Testing while online booking is paused.** The console button was removed on
request; `POST /api/staff/centro {action:"preview"}` still mints a signed 12-hour pass (`api/_lib/preview.js`) and opens the public
site with `?booking-preview=`. The notice script keeps it for that tab, shows
the real popup with a "test mode" badge, and adds `x-booking-preview` to its
`/api/` calls, which the server accepts in place of `ONLINE_BOOKING`. Bookings
made that way are real: name them ZZ and remove them.

## Staff console

- Home (`/staff`) is a grid of widgets the admin arranged. The Customize
  button (top right, only for `canManageTeam`) was removed on request on
  2026-10-26, so Home shows the saved layout and nobody can change it from
  the console; the editor code is still there, unreachable. Customize
  turned each card into an editor (move earlier or later, Bars/Line/Table
  where the widget has them, Half or Full width, remove), with Add widget,
  Reset (to the default, not saved until Save), Cancel and Save. The layout
  is one per salon, `tenants.home_layout` (019, also in ensure-schema), saved
  by `PATCH /api/staff/home` and cleaned by `layoutFrom` in
  `api/_lib/home-layout.js`, which also holds the widget catalog and
  `DEFAULT_LAYOUT` (the two figures and Coming up as before, with Booked
  ahead and Services between them). Every chart's numbers are counted in
  `home.js` (`charts()`): booked ahead 14 days, visits and booked value per
  week for 12 weeks, services, stylists and new-client sources over 30 days,
  busiest weekdays over 90; "kept" is not cancelled and not a no-show, and
  an appointment with no price is left out of value and said, never
  guessed. Charts are plain HTML/SVG in the console's periwinkle (`--viz`,
  `#7d88d6` in dark mode, both run through the dataviz palette check), one
  hover/focus tooltip, the peak or last value labelled. Home greets the person (asked for 2026-10-15): the heading is "Good
  morning/afternoon/evening, <first name>" on the salon's clock
  (`homeHello()`), beside the person's own headshot (2026-10-31, `paintPageFace`,
  ringed in periwinkle), and the subtitle a word for the day ("Happy Friday!",
  "Enjoy your Saturday!", "Have a great morning today!") then the date
  (`greeting()`). Since 2026-11-03 the greeting is revealed left to right as
  Home opens (`paintHello`, `.hello-in`: a 0.9s clip-path wipe of the whole
  line, so the Spanish layer still swaps it as one phrase; the subtitle
  fades in under it; none for reduced motion; the quiet reloads replay it
  only if the words changed). No primary button. Two tiles from `GET /api/staff/home`
  (`_routes/home.js`, counted in SQL), two equal columns as wide as Coming
  up, each a figure on the left and a periwinkle icon on the right: "N Salon
  Appts. Today" over "M Salon Appts. in the last 30 days" (started in the
  window, cancelled left out, `appts30`), opening Appt. Book; then "N
  Clients Served" (people with a kept appointment that started in the last
  30 days, each once; a contact with no visit is not served) over "N new
  clients in the last 30 days" (of those, the ones whose first kept visit
  was in the window, `newClients30`), opening Clients. Today's value is
  still counted (`today.value`) but no longer shown.
  Coming up lists the next six booked appointments in the reference's rows
  (tag, guest, service with stylist, when on the salon's clock, Open);
  clicking one opens that appointment's window on Appt. Book's Day view
  (`diaryOpenRef`, opened once its day loads), with
  "Past appointments (n)" underneath. Right of the nav is "Call Karen"
  (since 2026-10-30); the person chip that stood there became Settings'
  My settings tab, without its picture, and the count of people waiting
  for approval rides on the Settings gear. `.main` starts 116px down (108 and 100 on
  smaller screens) so titles clear the fixed nav.
- **No /staff in the app's addresses** on app.synergysalon.com (asked for
  2026-10-22): Home is `/`, then `/appointments`, `/clients`,
  `/marketing/automation`, `/settings`, `/calendars/<slug>`, `/invite`.
  vercel.json, for that host only, rewrites those names to the console and
  redirects every old `/staff/...` address to its new one (bookmarks and
  old invite emails keep working), except `/staff/vendor/` (the console's
  own scripts). `/` itself is redirected to `/home`: a rewrite cannot serve
  it, because `/` is the public site's index.html and a file beats a
  rewrite, so the console puts the address back to `/` once it is up. In
  the console `BASE` is `''` on that host and `/staff` elsewhere (a
  `*.vercel.app` or local address, where those names belong to the public
  site), `HOME_PATH` is `/` or `/staff`, and the menu's links are rewritten
  to match. Invite links from `team.js` follow the same rule.
- Nav: Home, Appt. Book (renamed Appointments for an hour on 2026-10-30 and put back on request, everywhere: the menu, the page title, the client profile's heading, Karen, the Google messages and the welcome email; only the profile's Activity filter says Appointments, on request), Clients, Settings (addresses above; Marketing, now named Automation, is a Settings tab since 2026-10-24). Clients has "Choose your stylist"
  (2026-10-22): All, then every stylist record from `contacts?stylists=1`
  (`stylistChoices`), with or without a login, calendar or payroll, so long
  as they are active or have ever been booked. One who has left has no
  button since 2026-10-31 (removed on request; it used to stay, marked
  "left"): their clients are under All and found by search, and the list
  still carries them for their face on those clients' rows.
  Each client is shown with their stylist, whoever they last booked with
  (`STYLIST_OF`), not their source, and as a face rather than a name tag
  (on request, 2026-10-30 and 31): the list's Book button wears it, and on
  the profile it is a headshot on the corner of the client's circle
  (`paintPxStylist`, `#pxSty`) and a Stylist row in Contact details (face
  and name, "When they book" until they have one). Neither the header nor
  Tags and status carries a stylist tag any more. The source tags ("Front
  desk") are gone from the list and the profile chips, and the source is
  still on the profile. The lead-stage filters were removed on request; each row still
  shows its stage. The stylist row stays on one line (scrolls sideways).
  Each stylist button shows their face (2026-10-30), ringed in periwinkle
  (one colour for everyone since 2026-10-31, no red; each stylist had a
  colour of their own from a list of eight before; `stylistPic`): the photo uploaded to their login
  (`staff_users.avatar`, a `data:` URI), else the website's portrait
  (`stylistPhoto` before `stylists.photo`, whose 012 path for Tami is a
  deleted file), else the avatar they chose, else a default (`personPhoto`).
  A client row has no ⋯ menu any more (removed on request 2026-10-30): Book
  is its one button (wearing their stylist's face, ringed in periwinkle,
  and booking with that stylist preset, `bookButton`; the calendar icon for
  a client with no stylist yet), and Edit details and Delete client are on the profile
  the row opens. So the Add client window (`#contactDlg`) only ever adds;
  its "Where did they hear about us?" is a list (2026-10-30), the website
  survey's answers plus Walk-in and Phone call, so sources are spelled one
  way. Left on "Choose one", the server stores "Staff console" as before.
- Tickets (2026-10-22): the appointment is the diary's reservation, the
  ticket the visit. `GET /api/staff/appointment?ref=` (`ticketFor`) is the
  one source for both the Appt. Book card and a client's history (their
  appointment rows and every timeline event with a ref open it, except a
  "Reminder email sent" with a row in `message_sends`: since 2026-10-31
  that opens the email itself, `sentId` from `contactDetail`, in Email
  History's window, `openSentEmail`; one sent before the log existed still
  opens the ticket): client,
  stylist, when, each service with its time and price, the total, payment.
  Lines come from `appointments.services` (migration 031), written at
  booking from `combineServices().lines`; a visit booked before that shows
  its first service and the total, marked not itemized, never a guessed
  split. Payment is "Not recorded" and there are no transactions: nothing
  records payments until Stripe. Check in, no-show, cancel, done, reopen
  and delete stay on it. Staff move a visit by dragging it (below).
- **Moving an appointment** (asked for 2026-11-02, and again the same day
  when a drag did not work for the salon): two ways, both for any booking
  still `booked` (`canMove`), one from earlier today included, to any time
  from now. **Move** on the appointment window opens `#moveDlg`: day,
  stylist, then the free times for the whole visit from `GET
  /api/staff/appointment?ref=&times=&stylist=` (`moveTimes`, the same
  `moveSlots` question the move asks). And **drag and drop** on the day: a
  booked card can be dragged to another time, or into
  another stylist's column; a ghost the length of the visit snaps to
  quarter hours and turns red where the grid can already tell it will not
  fit (passed, outside the salon's or the stylist's hours). A touch drag
  starts after a 350ms hold so a swipe still scrolls. On drop it confirms,
  then `POST /api/staff/appointment {action: 'move', start, stylist?}`
  (`moveAppointment`): the desk's rules (`minLeadMin: 0`, not limited by
  Google) through `availableSlots`, the visit's own length and breaks, the
  no-overlap constraint as the last word, then the reschedule email and
  text and the Google copy, as the guest's own reschedule does. The quiet
  two-minute reload waits while a card is held. A mouse drag holds pointer
  capture so the drop is never lost. **The Month view drags too**
  (2026-11-02): a booked chip (`.cal-mv`) dropped on another date opens the
  Move window on that date with the same stylist and the same time picked
  when it is free there (`openMove(a, {date, prefer})`), since the month has
  no times to drop on; one press keeps the time, or another is chosen.
  Passed days and days nobody on the team works (`salonWeek` from diary.js,
  shaded `.cal-cell.shut`) refuse the drop.
  **Every move is confirmed in one window** (`#mvcDlg`, `confirmMove`,
  2026-11-02), whether dragged on the day or saved from the Move window
  (where a month drag lands): "Are you sure you want to move this
  appointment?", the client and service, Original and New date, time and
  stylist, then **Send a Client Rescheduled Appointment Notification** (renamed
  on request, with a bell icon; Just Move has the calendar icon; the default;
  the reschedule email, and a text only with consent on record) or **Just
  Move Appointment**, and Cancel or Confirm. The choice goes as `notify` on
  the move (`notify: false` skips `sendReschedule`; the stylist's Google
  copy follows either way) and the reply's `notified` says which happened.
  With no email or phone on file only Just Move can be chosen.
- The client profile edits in place: a pencil on Contact details (name,
  phone, email); the status and tags in the header (below), Add note (a dated line
  on top, `PATCH {op: 'note'}`, one statement so two people's notes both
  stay; notes hold 8,000 characters), and Contact preferences: Email and
  Text messages, separate switches (`contacts.email_ok`, `sms_ok`, 031,
  `PATCH {op: 'prefs'}`). Email off cancels queued follow-ups in
  `cron/followups.js` ("client opted out of email"); confirmations,
  reminders and cancellations still go. Texts are stored only: nothing
  sends SMS. Timeline events carry a `tone` (booked, checkin, done, noshow,
  cancel, email) that colours them.
- On a phone (720px and narrower) "Call Karen" floats in the bottom-right
  corner and stays there while the page scrolls (2026-10-22): 52px tall,
  clear of the safe-area insets, with room left at the page's foot and the
  toast lifted above it. On wider screens it sits at the top, right of the
  menu (2026-10-30; it was in the page head), with Karen's number under
  "Call Karen" (`me.salon.karenPhone` from `/api/staff/me`, painted by
  paintKarenNumber(); hidden until a number is connected, and updated at
  once when Settings, Karen AI saves a new one). The bar is centred by
  margins, not `translateX`: a transform would make it the frame for the
  phone's fixed button.
- **New appointment is five steps again** (asked for 2026-10-23, after a
  day as one page): stylist, kind of service, service, day and time, client
  (`BOOK_STEPS`, `bookGo`). It keeps what the one-page form added: "Add
  another service" goes round kind and service again, and the visit
  (`bookLines`) is booked as one appointment with one stylist end to end;
  the times are always for the whole visit, and a time picked before the
  stylist or services changed is re-checked on the times step and cleared
  with a note if it no longer fits. The client step finds existing clients
  from the third letter (`bookContact`). A click on Appt. Book's grid opens
  on step 2 with that stylist, and the clicked time is chosen once the
  services are in, if it fits; Book from a client opens on step 1 with the
  client already filled in. The values sit in hidden `bookStylist`,
  `bookDate` and `bookTime`, which is all Karen and the booking read.
  Picking a stylist who does not do a service already on the visit takes
  it off and says so.
- Karen on the ticket (2026-10-22): "Help me book" in New appointment's
  header opens Karen's chat holding what the survey has
  (`openKarenFromTicket`), so she asks only the rest; she books for the
  linked client (`karen.contact`) and closes the ticket. A "Karen · Step n
  of 4" strip that sat on the ticket was removed on request the same day.
  Karen's picture is the first frame of the salon's own clip of her waving
  (2026-10-30, from karen.mp4: `assets/karen/karen-still-v2.webp` since 2026-11-05, `KAREN_PIC`,
  and `karen-wave.mp4`, `KAREN_WAVE`, 256px, 11.5s, played forward then
  backward so the loop never jumps, 180 KB), not a stylist's avatar. The
  header button is still and waves only while a mouse is on it or it has
  keyboard focus (`#karenBtnVid` over the picture; leaving puts her back on
  the first frame; touch never starts it), and so does the picture in her chat window's header while the mouse is over the card (`karenWave`; measured against the card's edges, since an open dialog's backdrop counts as the dialog). Settings, Karen AI shows her at
  88px (64 on a phone), waving on a loop. Neither moves for reduced motion.
  On a phone, Karen's suggestion chips, a profile's Activity filters and its
  pencils are 36 to 38px (they were 30), and her chat fills the screen with
  the ring as its frame; checked at 390 and 360px wide, nothing overflows.
- **Writing to a client from their profile** (2026-10-31): a box at the foot
  of Activity, Text or Email, as in the CRM's conversations
  (`composeHtml`, `PATCH /api/staff/contacts {op:'message'}`,
  `client-message.js`). A text goes from Karen's number signed "<first
  name> at Synergy Salon:", in plain characters, only to a client who agreed
  to texts and whose Text messages switch is on (the same rule as the
  appointment texts; the box says why when they cannot be texted); their
  reply comes to Karen's number and Karen answers it. An email goes from the
  salon's sender, replies to its inbox, signed by the writer
  (`sendStaffEmail`), kept with its words in `message_sends.body` so it
  opens again (kind `direct`, `sentMessage`). Every text with a client,
  either way, is in `client_texts` (039, also in ensure-schema): these, the
  appointment texts and their conversation with Karen, all under SMS on
  their Activity. `tests/client-message.integration.test.js` sends both
  through stand-ins.
- **Appointment texts** (sms-notify.js, live since 2026-10-28, from Karen's
  number): the confirmation, reminder, reschedule and cancellation, beside
  the email of the same kind. Since 2026-10-31 each opens "Hey! This is
  Karen from Synergy Salon." (the salon's words; it was "Synergy Salon:") and
  still ends "Reply STOP to opt out.". One segment is the default (asked
  for 2026-10-31): each kind has wordings from fullest to shortest and
  `fitText` (sms-length.js) sends the fullest within 160 plain characters,
  dropping the salon's phone, the client's name, the long date, the reply
  line and the stylist in that order; two segments only when even the
  shortest is longer (a long visit), and a service name is never cut. Every
  text, Karen's replies included, is put into GSM-7 first (`toGsm`, in
  `sendText` and `karenReply`): one curly apostrophe or accent outside it
  sends the whole text at 70 characters a segment. Only to a client whose consent is on record (`sms_consent_at`,
  from synergysalon.com/sms-opt-in or START), as the A2P registration
  promises, and never to one whose Text messages switch is off on their
  profile (`sms_ok`, now honoured). The profile says whether they have
  agreed and how to.
- **Karen's personality** (2026-10-31, the salon's own words):
  `KAREN_PERSONALITY` in `karen-ai.js`, warm, quirky and funny "like Phoebe
  Buffay", leading with the help, one fun line at most, no em dashes, jokes
  dialled down for anyone stressed, never a made-up fact, price or promise.
  One text shared by Karen by text and Karen in the app (karen-desk.js), each
  prompt keeping its own practical rules after it;
  `tests/karen-personality.test.js` pins that both use it. Her rule-based
  replies (the hellos, the booking steps) are fixed lines in the console and
  are not written by it.
- **Karen's Chat History and Call History** (2026-11-02): two sections
  on Settings, Karen AI that open and close from their headers like Email
  History (`.kx`, `setKx`, remembered as `ss-kh-open`/`ss-kc-open`, closed
  by default), each headed with its own icon (a speech bubble, a phone;
  `.kx-ic`). Chat History is what was Message History (below), drawn as a
  messaging app draws a conversation: Karen on the right in blue, the team
  member on the left in gray (the salon's choice, 2026-11-02, reversing the
  first arrangement; the tokens keep their first names, `--bub-user` blue
  and `--bub-karen` gray),
  each with their picture on the last bubble of a run and no name inside
  the bubble (taken out on request, 2026-11-02; it is the bubble's
  aria-label).
  Call History is every call to Karen's number (`karen_calls`, migration
  040, also in ensure-schema; `api/_lib/karen-calls.js`): kept when the
  voice webhook greets the caller (who, by their number), and the salon
  line's answer added when the `<Dial>` ends, through its action, the same
  webhook with `?after=1` (Twilio's `DialCallStatus`, `DialCallDuration`).
  `GET /api/staff/karen?calls=1`, the admin only. A client's row opens
  their profile. `tests/karen-calls.integration.test.js`.
- **Karen's Message History** (2026-10-31, now Chat History, above):
  Settings, Karen AI, Message History is Karen's inbox for the owner: everyone on the team who has
  talked to her, newest first, and each one's whole conversation, by day,
  marked "by text" where it was texted. The admin only (`canManageTeam`,
  the app's one rule: role Owner or Admin, or the support login): `GET
  /api/staff/karen?history=people|<id>` is `requireTeamAdmin`, and the
  section is hidden for anyone else. Kept in `karen_messages` (038, also in
  ensure-schema; `karen-log.js`), one row a message, from when it went
  live: nothing earlier existed to keep (`karen_threads` is only where a
  texted conversation has got to, overwritten and dropped after half an
  hour). The app's chat is read off the chat window itself (a
  MutationObserver on `#karenLog`), so whatever she says, by rules or AI,
  is kept as shown, posted as `{log}` and always as the person signed in;
  nothing is kept until the person has typed something, so opening and
  closing her is not a conversation. A team member's texts are kept in
  `karenReply` (karen-sms.js); a client's are not. The chat says under its
  message box that chats are saved for the salon owner to review.
- **The team by text with Karen** (2026-10-31; since 2026-11-03 a team
  member who is not the owner sees, books into and changes only their own
  chair, below): every team member, whatever
  their role (stylist, front desk, owner, admin), may book new appointments
  for clients and move or cancel any appointment in the salon by texting
  Karen, as anyone can on Appt. Book. It used to be their own chair only (the
  admin the whole salon), and no new bookings by text. `chairAhead` lists the
  whole salon's next two weeks; a team member's booking is a desk booking
  (`deskBook`: channel staff, booked by them, via Karen, the desk's rules:
  any free time from now, not limited by Google, open while online booking
  is paused), for a client found by `clientFor`: by the phone or email they
  give (matched, or a new client from it), else one client on file by that
  exact name; otherwise Karen asks for a phone or email, so nobody is booked
  without a client (Appt. Book shows only appointments with one). Still
  propose, then their YES. Changing a visit's services stays in the app.
- **Karen by text** (2026-10-22): Settings, Karen AI, Phone Number Settings
  shows the number clients call or text (`tenants.karen_phone`, migration
  033, also in ensure-schema; `GET/PATCH /api/staff/karen`, the admin
  sets it) and, for the admin, how to connect it. The phone provider is
  Twilio: its webhooks are `/api/staff/karen-sms` and `/karen-voice`
  (through the staff router because of the 12-function limit; no session,
  the caller is proved by Twilio's signature with `TWILIO_AUTH_TOKEN`, and
  without that variable every request is refused). `api/_lib/karen-sms.js`
  recognises the sender by the last ten digits of their number (team
  member first, then client), greets them by name once a conversation,
  tells a stylist what is on their schedule ("today", "tomorrow", "Friday",
  "this week"; somebody with no chair gets the salon's day), and lets a
  client see, cancel (after YES) or move (numbered openings, same stylist
  and length, same rules as the manage page) their appointment, with the
  usual emails and Google copies. New bookings by text follow
  `ONLINE_BOOKING`: while paused she gives the salon's number. Where each
  conversation is lives in `karen_threads`, forgotten after 30 minutes. A
  call is greeted by name and put through to the salon's phone.
  `tests/karen-sms.integration.test.js` runs the conversations. As of
  2026-10-22 no number is bought and `TWILIO_AUTH_TOKEN` is not set, so the
  page says "No number connected yet". Since 2026-10-30 (on request) the page only shows
  the number: the form to change it and the Twilio setup steps were
  removed, and `PATCH /api/staff/karen` still sets it.
- Karen's chat window (2026-10-30) is about 20% larger (552px by up to
  816px), with a live edge (2026-10-30: a 3px ring of periwinkle, pink and
  teal travelling round the card every 6 seconds, the border itself as a
  conic gradient turned by the `--kd-a` @property, and a glow outside it
  shifting through the same colours) and a drifting header gradient (all
  off for reduced motion), a compact ask area (smaller chips, summary
  card and message box, a send icon), and a varied hello (`kHello`: by
  the salon's time of day and weekday, with the first name, never the
  same line twice running). The line under her name is "<number> · Booking Assistant ·
  Online" (`karenStatus`, painted by `paintKarenNumber`), and her menu no
  longer offers "What services do you offer?" (typing it still works).
  She answers questions about what is already booked from the calendar
  (2026-10-31; "are there any appointments booked right now?" used to
  start a new booking, because her menu read any "book" as a request to
  make one): `kIsLookup` catches a question word plus appointments,
  bookings, schedule, calendar or busy, ahead of every other answer, and
  `kLookup` reads that day from `/api/staff/diary` on the salon's clock
  ("right now": who is in the chair and what is still to come; a day or
  "tomorrow"; a stylist by name; "next": Home's upcoming list). Asking
  for open times ("is anything free tomorrow?") is still a booking.
  **Karen in the app reads the records with Claude** (2026-10-31, after
  "when did Luiz Test get created?" and "have any emails been sent?" got
  "not sure"). A typed question (a question word, or a "?") that is not a
  request to book, for free times or for a price (`kIsQuestion`,
  `kWantsBooking`) goes to `POST /api/staff/karen` (`kAskAi`), as does
  anything the rules cannot place; mid-booking, only a real question
  does. `api/_lib/karen-desk.js` (`deskReply`) answers on the same model
  and key as Karen by text, with four tools that only read:
  `find_clients` (name, email, phone digits, or added between two days),
  `client_history` (`contactDetail` plus every email sent them),
  `appointments` (a range up to 92 days, cancelled ones marked) and
  `emails_sent` (the `message_sends` log). Nothing it does can book or
  write (`tests/karen-desk.integration.test.js` reads its source for SQL
  that writes and runs every tool against ZZ data with a stand-in model).
  It sees what the person asking may see (2026-11-03, `scope.js`): the
  whole salon for the owner, their own chair and its clients for anyone
  else. The last
  12 messages travel with each question for follow-ups. Without
  `ANTHROPIC_API_KEY` the endpoint answers 503 and the chat keeps to its
  rules for the session.
  **Karen in the app is an assistant now, not a menu** (2026-10-31, after
  "can you send an email reminder to Marian for her appointment today"
  started a booking: the rules matched "scheduled"). Whenever no booking
  step is waiting on an answer, a typed message goes to her AI first
  (`kAskAi`), with the conversation for context. She knows the app from
  `api/_lib/karen-knowledge.js` (`APP_GUIDE`: every page, setting, booking
  rule, email and common problem, in the words on screen, with the live
  `ONLINE_BOOKING` and `CLIENT_PRICES`; **change it when the app changes**,
  or she explains the old app with confidence) and looks the rest up:
  clients, history, appointments, emails, `team` (roles, services, hours,
  lunch, Google), `salon_settings` (automations off, reply-to, her number),
  services, and `free_times` (`availableSlots`). She acts through two
  proposal tools, `propose_send_emails` (reminder or confirmation) and
  `propose_appointment_action` (check in, done, no-show, cancel; never
  delete), and hands bookings to the steps (`start_booking`, a `handoff`
  the console feeds to `kBookFrom`). **She only proposes**, as by text:
  `api/_lib/karen-actions.js` checks the appointments (this salon's, in a
  state the action fits; what is left out is returned with why), keeps the
  proposal for that person in `karen_threads` under `desk:<user id>`, and
  the console shows a card with Confirm and Cancel (or a typed yes/no).
  `POST /api/staff/karen {confirm: id}` carries it out only if it is that
  person's latest, under 15 minutes old, re-checking each appointment,
  through the app's own `sendReminder`/`sendConfirmation` (logged, a sent
  reminder stamps `reminder_sent_at` so the daily run skips it) and
  `applyAppointmentAction` (lifted out of the appointment route, the same
  code as the buttons); the reply is written by code from the results.
  Anything else said drops the proposal. karen-desk.js stays read-only
  (its test greps it). Effort is medium. `tests/karen-actions.integration.test.js`.
  A sent email's window no longer carries the rebuilt-from-the-booking
  note (`note` is null unless the booking was deleted): the Email History
  header's info button says it once.
- **Booked by Karen** (2026-10-31): `appointments.booked_via` (migration
  036, also in ensure-schema) is `'karen'` for her bookings, in the app
  (`via: 'karen'` to `/api/staff/book`) and by text (`createBooking`'s
  `via`; earlier text bookings marked from her note). Every booking says
  who made it, the same everywhere (2026-10-31; `bookedLabel` in
  contacts.js, `bookedByLabel` in the console): "Booked by Karen", else
  "Booked by <team member>" for a desk booking (`booked_by`'s name;
  "staff" only when that login is gone), else "Booked by Client
  (Website)". On the client's Activity, Appt. Book's card and the
  appointment window ("Booked by: Karen, for <who asked>" when she booked
  in the app). `tests/booked-by.integration.test.js`. Phones are shown as (813) 555-0170 wherever a
  stored number is printed (`showPhone`: a whole US number formatted,
  anything else as it is).
- **Every email is on the client's Activity** (asked for 2026-10-31).
  `message_sends` keeps the subject as sent, `status` ('sent', or
  'failed' with the provider's `error`) and `contact_id` (migration 037,
  also in ensure-schema, which links older rows to their client through
  their appointment). `sendMessage` logs a refused email as failed before
  throwing as it always did. `contactDetail` lists every row that is the
  client's (by client, by one of their appointments, or by their address
  for a row with neither) under Email: the subject (`EMAIL_KIND`'s name
  for a row logged before subjects were kept), the visit, when, and a Sent
  or Failed chip, each opening the email. An appointment's
  `reminder_sent_at` adds a line only for a reminder from before the log,
  so nothing is listed twice. Email History and the email's window show
  the same status and subject; the automations' counts are of sent ones
  only; Karen's `client_history` reads the Activity's own list.
  `tests/client-email-activity.integration.test.js`.
- Clients, Activity: each kind of event has its own colour (asked for
  2026-10-22): booked green, emails (and texts, when there are any) yellow,
  checked in blue, done teal, no-show orange, cancelled red, the website
  form pink, added grey, Admin violet (2026-11-03). Contact details no longer repeats the phone, which
  is at the top of the profile; it is still edited with the pencil there.
- Payroll (2026-10-22): processed every Friday, staff and stylists paid by
  the end of that day. Since 2026-10-30 the Payroll tab shows only "Coming
  soon" (asked for); the schedule and next payday were taken off it. Nothing
  is paid from the app yet.
- Card on file (2026-10-22): a green "Card on file" chip under the client's
  name in Clients and on their profile, for the salon's preferred clients
  (a no-show can be charged the fee; a visit is paid through the stylist).
  It is a flag the team sets with the Payment switch on the profile
  (`contacts.card_on_file`, migration 032, also in ensure-schema since it is
  additive and defaults to no; `PATCH {op: 'card'}`, `setCard`). Nothing in
  the app takes or stores a card; when Stripe lands it can set the flag.
- Migration 031 was held out of ensure-schema until the salon approved it
  on 2026-10-31; it is in ensure-schema since, so the live database gets
  `appointments.services` and the client's email and text preferences on
  the next `/api/staff/me`. Reads still go through to_jsonb and writes
  through `hasColumn` (db.js), so nothing breaks on a database without it.
- **A visit is shown whole everywhere** (asked for 2026-10-31: a booking of
  several services showed only its first). `api/_lib/visit.js` is the one
  rule: `visitNameSql()` names a visit by its itemized services joined
  with " + " (031), else the website's "Services:" line in its notes, else
  its first service; `visitLinesSql()` and `visitLines()` give the lines.
  Every query that names a visit's service uses it: the ticket, the
  client's activity and appointment list, Appt. Book, Home's Coming up, the
  reminder and follow-up crons, Email History's window, the guest's manage
  page, Karen (app and text), the Google copy and the calendar feed. The
  booking returns its own lines, so the confirmation lists every service
  even on a database without 031. Emails show "Services", one per line
  (`detailRows`); one service reads "Service" as before. While
  `CLIENT_PRICES` is off no price is in them; on, each line carries its
  price and "Total" follows (one service: "Price"). The ticket has Service, Qty, Time and Price, and
  "Total · n services"; a visit of several services booked before the
  lines existed shows its services and only the total, never a split. A
  website guest who changes services mid-survey moves their booking with
  its new services (`service_id`, notes and lines), not only its length.
  `tests/visit.test.js` and `tests/visit-services.integration.test.js`.
- Team Settings has "Where do you want people to reply to": `tenants.reply_to`
  (017, also in ensure-schema), the reply-to on every guest email
  (`shopFrom().replyTo`), falling back to the salon profile email when empty.
  Once confirmed it shows locked (the address, a green "Saved" badge, a
  Change button and a "Client replies now go to" line), because an open field
  after Confirm read as nothing having happened. Salon Profile and calendar
  settings leave a "Saved" mark by their button (`markSaved()`) until edited. Stylist is a role (016,
  also in ensure-schema) with front desk's access. A Leads page
  held the stages for a while; `/staff/leads` now lands on Clients. Settings is as
  wide as the nav cluster (`--nav-w`, measured by `fitSettings()`), so its
  edges line up with the menu. There is no Calendars item, and since 2026-10-15 the shop's calendar
  chips are gone from Appt. Book too (on request: "Synergy Salon Calendar ·
  30 min" read as the length of every booking); `/staff/calendars` still
  lists them. A booking calendar's own length (`duration_min`, 30 unless
  set) is never used to book: every appointment is as long as its service
  (`combineServices`), online and at the desk, which
  `tests/synergy-calendar.integration.test.js` pins. So the calendar screens
  show and ask for a length only for a class or an event (`calSeats`). Settings is
  for everyone: a My Settings tab first (capital S since 2026-10-30) (your picture, ringed in periwinkle like Home's (`#myFace`, painted by `paintMe` from `personPhoto`, so a new one shows at once; it opens your profile window, 2026-11-03), your name and role with Edit my profile, Appearance, Sign out; key `me`, where Settings opens, 2026-10-30, in place of the person chip), a Salon tab (Salon Profile, then Where do you want people to reply to; key `salon`; Salon Profile first since 2026-10-30, and without its Salon email field since the same day: the stored address is kept, still the reply-to fallback, and the save leaves it out) and a Team tab (Team Members; key `team`, where `/account` opens), split on request on 2026-10-23 after a week as one "Salon & Team" page, and a Money tab for owners, admins and managers (key `payment`; "Money" since 2026-11-02, with Finance first since 2026-11-03 and then a **Subscription** card: the plan, its price from `SUBSCRIPTION` in the console, which is `null` until the salon sets it and so reads "Pricing coming soon", and an Activate subscription button disabled and marked Coming soon until payments are connected (both chosen by the salon, 2026-11-02); "Payments" from 2026-10-31, as is the client profile's Card on file section, while an appointment's own window keeps "Payment";
  it was the Payroll tab until 2026-10-30): a Billing card and a Payroll card, both "Coming soon".
  Billing was a tab of its own, then a card on Salon (2026-10-26), and moved to Payment on request
  on 2026-10-30; old `payroll` and `billing` tab names land on Payment. It has no Calendars tab:
  calendars are made from Appt. Book's "Create a calendar" note (shown only
  while there are none) or `/staff/calendars`, without choosing members for now
  (stylists are not on the app yet; calendar settings saves members back
  unchanged and no longer shows a picker), and the New calendar form offers the
  calendar apps (Google by sign-in, and any other app by subscribing
  to the person's private feed, links from `GET /api/staff/calendars`), Outlook is left out of the form on request (`calAppRows()`). `/staff/account`
  opens Settings on Team. The calendar settings page has a Back button to Appt. Book, on the Day or Month view last open (`ss-cal-view` in `localStorage`). Sign out is in your own
  profile window. `/staff/dashboard` and `/staff/contacts` still land on Home and
  Clients. The UI says "CRM"; the API keeps its `centro`
  names, which nobody sees.
- **The team member window** asks for each fact once. The header is the
  person: their picture (the circle, or Change picture, opens its own small
  window: Upload a photo or Choose an avatar), their name as the heading,
  edited in place (it is the Name field), and @username under it, each
  with a pencil that puts the cursor in the field (hidden where it cannot be
  edited). Then
  Personal information (Email, Role; phone is `staff_users.phone`, edited under the name,
  007, now read and written by `team.js` as well as `profile.js`), Connect
  your tools, Services & pricing, Working hours. A stylist without a sign-in shows only
  services and hours (name and picture read-only). Working hours are set
  by the admin only (`hoursOpen()`: the admin on somebody else's window or
  adding somebody); a stylist sees their own grey and disabled, and
  `/profile` ignores hours sent to it, so the stored ones are kept; the steps card
  that used to say what opens it was removed on request. The admin
  (`canManageTeam`, the app's one admin rule: role owner, role **admin**
  (`TEAM_ADMIN_ROLES` in `auth.js`, migration 021, also in ensure-schema,
  added 2026-10-16 so the person running the app need not be titled Owner),
  or a `TEAM_ADMIN_EMAILS` login; managers are not admins; Luis Lara is the
  admin, so his account needs the Owner or Admin role). An Admin also gets
  everything a manager has (billing, deleting clients and appointments) gets neither Services & pricing nor Working hours (`#memberWork`
  hidden, `admin` flag from `/profile` and `/team`, and the server ignores
  services sent for an admin), and admin rows on the Team list show no
  service chips. Dina Lara is the owner AND a stylist: if she is given a
  login as Owner her services disappear with it, so give her the Stylist
  role. Classes are `wh-` prefixed: the console already has a
  generic `.locked`, which once made this section inline-flex. Open, each
  day shows the coming week from that calendar (busy times and what is left
  of the shift) via `GET /api/staff/calendars?busy=week`
  (`&member=` for the owner and the support login). Your own window now gets your hours
  and Google status from `GET /api/staff/profile`, and `PATCH` saves hours
  and syncs the stylist row as `team.js` does; before, your own hours opened
  empty and were thrown away on save.
- **The team member window's header** is the picture, the name (edited in
  place) and the phone under it (`#memberPhoneRow`, asked for 2026-10-16).
  The phone is edited there in place, and since 2026-10-30 one pencil
  beside the name ("Edit name and phone") serves both, and
  Personal information no longer has a Phone field (Email and Role only).
  The phone is written as a US number while it is typed, (813) 555-0170
  (`usPhone`, 2026-10-30): a leading 1 or +1 is dropped, another country's
  + or more than ten digits is left as typed, and it is saved and shown on
  the Team list in that form. Karen and the server match phones by digits. The username is
  no longer shown there: its row is hidden but stays in the form, so saving
  keeps it, and the Clients filters still label people by it. Connect your
  tools has a Stripe card under Google's reading "Coming Soon" (since 2026-10-30 the two cards read "Google" over "Calendar" and
  "Stripe" over "Payroll", and Google's has a green Connected or red Not
  connected badge on the right beside its button; the old explanation line
  is the card's hover text)
  (`.gcard.soon`, nothing to press). Services & pricing has Price and
  Duration (minutes, 5 to 720) on each service, and inside each service's
  card, directly under its description, a "Notes / Special Instructions for
  Clients" field (labelled "Special Instructions When Booking Clients" since
  2026-11-03; the section under it is "Available Hours", was Working hours). Since 2026-10-17 (on request) that is **one shared box
  under all the services** (the last card), always shown, instead of one
  per card; notes saved per service are carried into it, labelled. Color
  has no single Duration: it has Start, Break (processing) and Finish, once
  for Color and once for Highlights, with the total beside each. All of it
  lives in the same `services` object (`{cuts: {on, price, duration},
  color: {on, price, duration, start, break, finish, highlights: {...}},
  ..., notes, items}`, cleaned by `servicesFrom` in `profile.js`):
  **each kind opens to its services** (asked for 2026-11-02; since
  2026-11-03 a kind switched on opens by itself and one switched off folds
  back to its one line, its chevron hidden, animated by grid rows, nothing
  typed inside lost because the folded fields are still read on save): the
  kind's name is a button with a chevron, and open it lists every service of that
  kind from the menu (`me.services`), ticked if offered, with its own
  minutes (`items: {<slug>: {on, duration}}`). A service with no entry is
  offered whenever its kind is on, as before; an unticked one is left out
  of `stylist_services` (`serviceIdsFor` in roster.js), and its own minutes
  beat the kind's figure, which beats the menu's (`ownTiming` in timing.js;
  a kind's processing break is kept where it still ends before the
  service). The placeholder in each minutes box is what it would be booked
  for if left empty. `tests/service-items.test.js` and roster's integration
  test.
  `staff_users.services` for a team member, `stylists.service_details`
  (023, also in ensure-schema) for a stylist without a sign-in. These
  lengths **do** set how long a guest is booked with that stylist (see
  Booking); the notes are not shown to guests yet.
- **Connect your tools** is one "Connect Google Calendar" button in the team
  member window (yours, or anyone's for the owner and the support login). It opens an
  account chooser laid out like Google's (`#gDlg`), listing the accounts the
  console already knows for that person (their login email, the connected
  account, and ones connected for them from this browser, `ss-gaccts-<id>`
  in `localStorage`) plus "Use another account". With the OAuth client set,
  the button skips that window and opens Google's own account chooser
  directly (`prompt=select_account`), which is what the team asked for: no
  address to find. The console's chooser and the pasted address are only the
  fallback while the client is missing (as of this writing only
  `DATABASE_URL` is set in Vercel). Google Calendar only, for now,
  two ways in. Pasting the calendar's "Secret address in iCal format" works
  with no Google setup (`google-ics.js`: `readIcsLink` fixes quotes, spaces,
  webcal:// and a missing https://, and names each common wrong paste
  (calendar ID, the browser link, a cut-short address); `checkIcsLink`
  fetches it and reads today before it is kept, and says what Google
  answered (404 private: reset; 404 public: calendar not public; 403: a
  Workspace admin turned secret addresses off). The reason shows under the
  field and is logged as `google-link refused`, never with the address.
  calendar.google.com only, verified against live Google from a Vercel
  sandbox, `staff_users.google_ics` (018),
  encrypted when `TOKEN_KEY` is set, plain until then; parsed with ical.js,
  repeats and moved occurrences included, times only). Signing in with
  Google needs the OAuth client below and is offered as a second link once
  it exists; when both are set the sign-in is read. Connecting for somebody
  else (`/api/oauth/google?start=1&for=<id>`) is for an owner adding a
  stylist who signs in to their own Google beside them. Each connected
  person is a column on Appt. Book's day view: their Google busy times read
  live by `busyBetween` in `google.js` (and `icsBusyBetween` for a pasted
  address), their own salon bookings and blocks, and the salon-wide
  ones. Clicking an empty time books with them. Since 2026-10-31 each
  Google event shows its own name, as in their calendar, to the person
  and the admin (`titles` in `diary.js`; the fields mask asks for
  `summary` only then); colleagues, and any event marked Private in Google
  (`visibility`, or `CLASS` in a feed), still see "Busy". Online
  availability and the team window never ask for names. The bands outside
  a stylist's working hours (`offHours`, `.dg-offhrs`, below) are headed
  "Block · Not bookable" with the reason under it ("Starts 9 AM", "Done at
  3 PM", "Not working today"), on request. They cannot be clicked: the
  desk's booking form offers only times inside working hours anyway, so a
  click-through would have opened a form with nothing to pick (an option
  offered to the salon on 2026-10-31 on that mistaken premise, then
  withdrawn). Google busy time blocks
  online availability (google-busy.js). Sign-in needs `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET` and `TOKEN_KEY` in Vercel; the pasted address needs
  nothing. `pushEvent` writes bookings into the Google Calendar of stylists
  who signed in (google-mirror.js).
  All three are set as of 2026-10-13 and one account has connected end to
  end. **The OAuth app is still in Testing**, which has two consequences
  nobody is warned about: anyone not on the test-user list is refused with
  `403: access_denied`, and Google expires refresh tokens after 7 days, so
  a stylist who connects silently drops off each week. The account that
  worked first (`support@unclelouieproductions.com`) only worked because it
  has access to the Cloud project itself, which bypasses the test-user
  check -- so a successful connection proves nothing about anyone else.
  Fix both at `console.cloud.google.com/auth/audience` -> Publish app.
  Publishing does **not** remove Google's "hasn't verified this app"
  warning: `calendar.events` is a sensitive scope, so every stylist sees
  that screen and has to click Continue, and only Google's verification
  review (privacy policy, homepage, demo video) clears it. Tell them to
  expect it, or they press "Back to safety" and report a broken link.
  `TOKEN_KEY` must be at least 16 characters or `secrets.js` throws, and
  `canStoreSecrets()` turns that into a polite refusal instead of a crash.
  Working hours (2026-10-31) is only the hours and the Lunch break switch:
  its description sits under the title, and the connected calendar's week
  that was written under each day (`?busy=week`) is no longer shown or
  fetched.
  The tools card shows which Google account is connected under its
  "Connected" badge (2026-10-31; it was only the hover text), for you and
  for the admin; a colleague sees just the badge.
  Connected means connected either way (`googleStatus`), everywhere: the
  tools card, the New calendar form's Google row (`calAppRows`, which used to
  read only the sign-in and offered Google again to anyone connected by the
  address) and the calendar dialog. `GET /api/staff/profile` carries the
  status, so your own window opens right instead of offering Connect until a
  second request answered; it says "Checking…" if the status is missing.
- **Appt. Book's day is the salon's working day, from its team's hours**
  (asked for 2026-11-02, twice). It was first cut to the PMC's hours, held
  as a per-salon constant; the salon then asked for it to follow the hours
  the team actually sets, so that is gone. `salonWeek` in
  `api/_lib/salon-hours.js` reads `stylist_hours` of the active team: each
  day runs from the earliest anyone starts to the latest anyone finishes
  (Monday 9 to 6 shows 9 to 6; Tuesday 9 to 3 shows 9 to 3), and a day
  nobody works is closed. diary.js sends it as `salonHours`/`salonClosed`
  for the day and `salonWeek` for the month (closed days shaded, refusing
  a dropped appointment); with no hours set at all it is left out and the
  grid falls back to 9 to 6. The grid widens only for an appointment or
  block actually outside the day, never for a Google event; a closed day
  with nothing on it says so instead of a grid. Nothing cuts bookings to
  it: each stylist's own hours already do that in `availableSlots`.
- Appt. Book's day is the team, one column per person: (since 2026-10-30 the page
  widens with the columns, 320px each past the standard 960px, up to the
  window's width, then scrolls sideways; `--diary-w` from renderDiary(),
  `.main.diary`; Month and the other pages keep 960px) the shared
  "<salon> Calendar" lanes that used to sit on the left were removed on
  request (2026-10-15). Nobody is put in it: whoever has connected their
  Google Calendar (signed in or by the pasted address) is in it, one column
  each ("Team member" with the Google mark), because `diary.js` lists the
  connected people with every day it sends, so connecting makes a stylist a
  booking option on the grid at the next load; the day reloads quietly when
  the tab regains focus and every two minutes while it is open (no dialog
  over it). A person's column holds their Google busy times, their own
  bookings and their own blocks, and clicking an empty time books with them.
  So a booked client never vanishes, a stylist who has not connected gets a
  column ("Not connected") on any day they have a booking or block, and
  bookings with no stylist share an "Unassigned" column, a lane per overlap.
  Salon-wide blocks are drawn in every column. While there is nothing to
  show, one empty column says how to get in. The shop's extra booking
  calendars no longer gate the page: the diary and New appointment always
  work, because every appointment is in the Synergy Calendar. It has no
  "+ New calendar" chip (removed on request). LUNCH and BLOCK are rows in
  `time_off`, the table availability already subtracts, so a block on the
  grid really stops the time being sold.
  **Working hours on the grid** (asked for 2026-10-31): diary.js sends
  `hours` with each day, every active stylist's shifts for that weekday as
  minutes (`[[540, 960]]`; `[]` is a day off; somebody with no chair is not
  listed), read from the same `stylist_hours` availability.js offers from.
  The grid hatches the time outside them (`.dg-offhrs`, "Starts 9:00 AM",
  "Done at 4:00 PM", "Not working today") and a click there says why
  instead of opening New appointment. Every path that books or moves a
  visit (online, desk, Karen, the guest's manage page) already goes through
  `availableSlots`, so none of them can land outside the hours either;
  `tests/hours.integration.test.js` pins the day off, the desk and the grid.
  **Blocks reach Google too**: a lunch or block put on a stylist who signed
  in with Google is copied into their salon calendar there (`pushBlock`,
  "Blocked · <reason>", after the answer through `waitUntil`) and taken out
  when the block is removed (`dropBlock`); `google_blocks` (migration 035,
  also in ensure-schema) records each copy. Working hours themselves are
  not written to Google: its API has no working-hours setting to write, and
  a week of "not working" events would bury the stylist's own calendar.
  **The flexible lunch** (asked for 2026-10-31): half an hour somewhere
  between 11:00 and 1:00 for every stylist (`LUNCH`, `lunchGap` and
  `flexLunchOn` in timing.js), with no fixed place. `availableSlots` offers
  a time only if 30 minutes of that window are still free after it (where
  bookings already leave none, as a desk booking can, it stops nothing
  else), so a booking may take the lunch's current time and the lunch
  moves. Off for a day with a lunch put on the grid by hand. The switch is
  `lunch` in the stylist's own settings object (`staff_users.services`, or
  `stylists.service_details` for the four without a sign-in; `servicesFrom`
  keeps it, on unless switched off), shown as "Lunch break" under Working
  hours and set by the admin like the hours (a stylist saving their own
  prices keeps theirs). diary.js sends `lunch` (where it falls now) and the
  grid draws it as a dashed "Lunch · flexible" band clicks pass through.
  Test fixtures switch it off (`makeBookable`, availability.test.js's stub)
  so each tests its own rule; `tests/hours.integration.test.js` tests it.
  **Passed time** is greyed out on the grid (`.dg-past`, a day before
  today whole, today up to now) and a click there says so; New
  appointment's calendar strikes out past days (`.bw-day.past`) and its
  time list shows every time in the working day (`open` from
  `/api/staff/availability`, each date's earliest start and latest finish),
  the free ones to pick and the rest struck through, "Passed" or "Taken".
  Each column's header shows the person's role (`ROLE_LABEL`), not "Team
  member".
  `?demo` on the address shows a sample day that saves nothing.
- **Automation** is a **Settings tab** since 2026-10-24 (it was an item in
  the top menu called Marketing): `set-marketing`, after Team; the key is
  still `marketing`. Since 2026-10-30 (on request) it is named Automation
  and is one page: the automations (`#mktCard`), then **Email History**
  under them (`#mailCard`), with no switch between them. Both old addresses
  (`/marketing/automation`, `/marketing/history`; `group: 'settings'`,
  `view: 'settings'`) open it, the second scrolled to the history; the gear
  opens My settings. Each automation in the list shows its trigger under
  its name (`a.when[1]`, the line that heads its flow; 2026-10-30), e.g.
  Appointment Booking: "A client books an appointment". Email History is its
  own module now, with a search by name or address and a filter by message
  (`?history=1&q=&kind=`), each row a compact one-line card opening that email (`?sent=<id>`,
  `sentMessage`), the list capped at 760px. The whole section opens and
  closes from its header (2026-10-30; closed by default, remembered per
  browser as `ss-mail-open`, opened by the history address), with an info
  button on the header's far right saying the email is rebuilt from the
  booking. The tab and the list's
  heading read Automations (on request, later on 2026-10-30). The log keeps who, which message and when, not a copy, so
  the email is rendered again from the booking as it is now and the window
  says so; the manage link carries a dummy token, never the guest's; a
  booking deleted since shows sample details. **Finance** moved to Home on
  2026-10-24, and on 2026-11-03 to Settings, Money, above Subscription
  (`#homeFin`, an `.acard`, drawn by `renderFinance()` when the tab opens;
  `/marketing/finance` still lands on Home), owners, admins and managers only (the card stays hidden for
  anyone else, and a 403 from `?finance=1&from=&to=`): what visits were
  worth in a period, total and by stylist -- earned so far, average visit,
  booked ahead -- counted as Home counts value (kept = not cancelled and not
  a no-show; the booked price, else the service's; unpriced visits named, not
  guessed). The app records no payments yet, and Finance says so on the
  page. The old `/marketing/email` address opens Email History.
- **Booking references are not shown** (asked for 2026-10-24; the client's
  Activity lost its "Ref" line on 2026-11-03, which shows the visit's own
  date instead): not in Email History or its email window, the appointment window, Karen's
  "all set" card, any guest email (`detailRows` has no Reference row) or the
  guest's manage page. The ref still travels in links and addresses, where
  it finds the booking.
- Marketing, Automation (checklist of 2026-10-22): no search box; compact
  rows, about half their old height, two columns, all twelve on one screen,
  each with On/Off in words beside its switch. Turning one **off** opens a
  confirmation that requires typing the automation's name (`confirmTurnOff`,
  GoHighLevel-style); turning on needs nothing. Windows (automation, message
  preview, the off confirmation) share `.au-head`: one flat brand colour
  (`--indigo-deep`) with white type, readable in light and dark mode. Every
  flow's first step carries a "Start · Trigger" label, and its steps show
  Off when the automation is switched off. The booking flow uses the
  client's words: "A client books an appointment online, at the front desk,
  or in this app.", "Block the calendar" (it goes in the appointment book so
  another client cannot book the same time), "Confirmation Message", and
  every step's link reads "View Message". The message preview offers only
  the channels its step sends (asked for 2026-10-22): an email-only step
  shows the email with no tabs; the Confirmation Message has Email and SMS
  tabs. The "Plain text" tab is gone. Email keeps its From, To, Replies and
  Subject. SMS is from "Karen from <salon>" at Karen's connected number
  (Settings, Karen AI; "No number connected yet" until then) to the sample
  client's name and phone, with the text itself (`smsText` in
  karen-sms.js, kept to one text) and its length. No SMS is sent anywhere
  yet.
- **Automations has a submenu of two** (asked for 2026-11-06), laid out
  as the Finance card's period buttons (`.seg .fin-seg`): **Booking
  Management**, every automation the app runs (the Appointment Book
  heading over them was removed on request) (all are started by an appointment or its absence; the owner's
  Team Member Invitation is there too, having no better home), and
  **Marketing**: **All Holidays**, **Slow Day** and **Invite a Friend**,
  each a Coming soon card with no switch (`AUTO_GROUPS`). They are not
  built on purpose: marketing to a list needs an unsubscribe link and the
  clients' agreement, and the texting registration says no marketing. The
  tab is remembered per browser (`ss-auto-tab`).
- **Sent History under each automation** (asked for 2026-11-02; on the
  Automations page for a few hours on 2026-11-03, then back in the window on
  request): below "View only. This is what the app does on its own." in the
  automation's window, a card that opens and closes like Email History (`#autoHist`,
  remembered as `ss-auhist-open`, closed by default) lists who that
  automation reached, newest first, 40 at a time with Show more: the
  client, Email or SMS, the address or number, which message when it has
  more than one, when, and Sent or Failed (the provider's reason on hover).
  From `GET /api/staff/business?sends=<its kinds>` (`automationSends`):
  `message_sends` and the outgoing `client_texts` of the same kinds, merged.
  An email row opens the email (`openSentEmail`), a text row the client's
  profile. The flow, that line and the card scroll together (`.au-scroll`).
  `tests/automation-sends.integration.test.js`.
- Marketing, Automation lists the automations in two columns (one on a
  phone), each with its switch and no "N sent" count, and under them **Email
  history**: every email the automations have sent, newest first, 50 at a
  time with Show more, on the salon's clock (`GET /api/staff/business?history=1`,
  read from `message_sends`, so only what actually went out, and only since
  migration 024). It replaced the per-automation count and its recipients
  popup (2026-10-22).
- Marketing is Automation only: the Promotions, SMS and Email tabs, which were
  "coming soon" placeholders, were removed on request (2026-10-22). Their old
  addresses (`/staff/marketing/promotions|sms|email`, still rewritten by
  `vercel.json`) open Automation through `PAGE_ALIASES`.
- Marketing, Automation is a list of automation names (Appointment Booking,
  reminder, reschedule, cancellation). Each opens a modal with its flow as numbered icon tiles left to right (the original confirmation picture), sized to its step count, and
  each email step opens the email itself, rendered by the sending code in
  `api/_lib/email.js` (`MESSAGES`, `previewMessage`) through
  `GET /api/staff/business?preview=<kind>` with a sample appointment. Add a
  message to `MESSAGES` and it can be previewed; there is no SMS yet, so none
  is shown. Marketing takes the nav's width, like Settings.
- Settings, Salon Profile is the tenant's details, as a listing since
  2026-11-03 (in the shape of a Google business card, asked for): the logo
  on the left with Change logo and Remove under it, and on its right every
  detail as a bold label and a small value, one per line: Salon name, Phone,
  Website, Google review link, Address, Booking page, Time zone. A pencil
  turns the editable ones into fields in place with Save and Cancel
  (`bizEditing`); Booking page and Time zone are only shown. About was taken
  off and there is no standing "Save Salon Profile" button any more; the
  save leaves `about` out, so what is stored is kept. Its logo is the nav's
  mark, painted from `me.salon.logo`, so saving updates the menu at once.
- Team lists only the signed-in person for now (stylists are added later),
  plus anyone asking to join. Each person has a username (011) and their own
  services and prices, `staff_users.services` (012): Cuts, Treatments, Color,
  Styling, each on or off with a price they typed (dollars and cents, the
  field steps by 0.01; it used to step by 1 and the browser refused to save
  45.50). Never a computed price.
  Reads use `to_jsonb` so the console loads before 011 and 012 run; saving
  those fields needs them.
- An uploaded photo is cropped before it is kept (2026-10-31): Change
  picture opens it in a round frame to drag (mouse, finger, arrow keys) and
  zoom (slider, wheel, pinch, + and -), and Use photo saves exactly the
  circle as a 256px JPEG square (`cropOpen`, `cropUse`); Back returns to
  the two choices.
- Faces are pictures, real ones first: an uploaded photo, then the stylist's
  portrait (`api/_lib/stylist-photos.js`, also copied to `stylists.photo` by
  012), then an avatar the person chose, then a default avatar. Avatars are
  Microsoft's Fluent 3D emoji people (MIT, `assets/avatars/`), the style the
  team picked; the stylists are all women, so the default is always a woman,
  and men are only there to be chosen. A chosen avatar is stored in
  `staff_users.avatar` as its `/assets/avatars/...` path. Someone added
  with no picture chosen is saved with the default the window showed them
  (drawn from their name as it is typed, `charAvatar`); before 2026-11-03 it
  was left unsaved, the window had drawn it from "new" and the Team list
  drew another from the name, so the face changed once they were added.
- `api/_lib/ensure-schema.js` adds the 011 to 013 columns on the first
  `/api/staff/me` of each warm function, because production ran ahead of
  `db:migrate`. Idempotent; `db:migrate` remains the record.
- Team Members lists you, then everyone else on the team, each card opening
  the same modal, then an "Add a team member" row. A card (`memberRow`,
  redesigned on request 2026-10-16) is the picture, the name with the role
  chip beside it, the phone under it (not the email, not the services), and
  on the right two status boxes (`.tm-stat`, 2026-10-23, replacing one
  "Calendar connected" chip): Connected (green, a tick) or Disconnected
  (red, a no-entry sign) over CALENDAR, from `m.google.connected`, which is
  what decides whether a guest can book them online; and the same over
  PAYROLL, which is Stripe and reads Disconnected for everyone until
  something connects it. A stylist
  without a sign in reads as not connected. Since 2026-11-03 only the owner
  reads the team; anyone else sees their own account only (below). Until
  then everybody could read the
  team (name, picture, email, phone, role, services, hours: `GET
  /api/staff/team` is `requireStaff`), as the salon asked, but only the admin
  changes anybody else: POST is `requireTeamAdmin`, and a non-admin opening a
  colleague gets the window read-only (fields disabled, no pencils, no Save,
  no Remove, no Connect, a note saying the admin changes it). A non-admin's
  copy leaves out requests to join, invite state, notes, who approved whom
  and which Google account a colleague connected (only connected or not).
  `canManageTeam` in `auth.js` (role owner, or an email in `TEAM_ADMIN_EMAILS`
  in `config.js`, today support@unclelouieproductions.com) gates every
  change on `/api/staff/team`, connecting a calendar for somebody else, and
  the console's admin controls (`me.user.canManageTeam`). The admin views and
  edits every account, owners included (the "only an owner can change an
  owner" checks in `team.js` use `canManageTeam`, so the support login is not
  blocked). Appt. Book's day sends a colleague's connected Google address
  only to that person and the admin.
  `/api/staff/me` still lists everybody's name, role and username for the
  Clients filters and the diary. Managers keep the rest of `canAdmin`
  (billing, deleting clients). Adding somebody sends the welcome
  (`sendInvite`, `welcomeContent` in `email.js`): the one-use setup link
  (they choose their own password; none is ever emailed), the app address,
  what to fill in on their own account, and how to connect their calendar.
  It is skipped without `RESEND_API_KEY`. Since 2026-10-14 the key is set,
  so the dialog says only that they have been emailed; the link is shown
  just when sending failed or no provider is connected (`invite.emailed`
  from `team.js`, commit `7cb18b4`). The sender used to be `BOOKING_FROM_EMAIL`,
  which **must** be on the domain verified in Resend: the salon verified
  `noreply.synergysalon.com` while the code still defaulted to the root
  domain, and every send failed with a 403 that never reached the console.
  **Every email the app sends** (booking confirmation, reminder, reschedule,
  cancellation and the team welcome) comes from `noreply@synergysalon.com`
  (`SENDER` in `email.js`, `FROM_EMAIL` overrides), asked for 2026-10-15.
  The root domain is **not** verified in Resend, so until it is, Resend
  refuses that sender and `send()` retries from `noreply@` on
  `BOOKING_FROM_EMAIL`'s domain (`FALLBACK`, today
  `noreply@noreply.synergysalon.com`), logging why. `BOOKING_FROM_EMAIL` now
  only says which domain is verified. Verify synergysalon.com in Resend and
  the fallback stops being used.
  Replies go to `shopFrom().replyTo` (`admin@synergysalon.com` since
  2026-11-06, asked for; `hair@synergysalon.com` before), which is a
  different address on purpose and not a Resend domain.
- **Karen answers the salon's email** (asked for 2026-11-06,
  `api/_lib/karen-email.js`). Mail to the reply-to inbox (admin@, Google
  Workspace) is copied by a Workspace routing rule to Karen's receiving
  address at Resend (Resend Inbound, a subdomain with its MX at GoDaddy);
  Resend's `email.received` webhook calls `/api/staff/karen-mail`
  (`_routes/karen-mail.js`, no session). The webhook is trusted for the
  email's id only: the email is fetched from Resend with `RESEND_API_KEY`
  (`GET /emails/receiving/{id}`), so a forged call can only point at mail
  Resend really received. Each email is stored once (057:
  `email_messages` unique on Message-ID and on Resend's id), threaded by
  References, else same sender and subject within 30 days, and answered at
  most once (the reply row is claimed first, `answers` unique; a retried
  webhook is a duplicate and does nothing). Not answered, with the reason
  kept: the salon's own mail and Karen's (`X-Synergy-Karen`, `APP_SENDERS`,
  the inbox itself: Karen's alerts go to admin@ too, so this is the loop
  guard), auto-replies, bulk and list mail, no-reply senders, a team
  member's email (Karen's team powers stay on text), a sender neither
  Resend nor Google vouched for (DKIM or DMARC pass, Google's verdict read
  from `ARC-Authentication-Results` since the copy has been routed), a new
  conversation the sorter (Haiku, one word) calls `sensitive` (flagged) or
  `other` (skipped), anyone Karen answered six times this hour, and
  anything she hands to the team with `alert_salon`. Otherwise she answers
  with the text conversation itself (`converse` in karen-sms.js, state in
  `karen_threads` under `email:<address>`, `KAREN_EMAIL_PROMPT`), and a YES
  on the first line of a reply carries out what she proposed, as by text.
  The signature is added by code. She sends as the inbox
  (`sendKarenEmail`), which needs the root domain verified in Resend;
  until then Resend refuses it and she sends from the fallback with
  Reply-To the inbox. Settings, Karen AI, Email Inbox (the admin only)
  lists it all, with the switch (`tenants.karen_email_on`).
- Appt. Book shows only appointments of a client who still exists (since
  2026-10-31, `ct.id IS NOT NULL` in `diary.js`): deleting a client
  (`removeContact`, which cancels what was still to come) sets their
  appointments' `contact_id` to NULL through the foreign key, and they
  leave the calendar, Day and Month, and its counts. The rows are kept, not
  deleted. A booking that never had a client is left off too; every
  booking has had one since `contactFor`.
  Removing somebody deletes them (`action:"delete"` on `/api/staff/team`,
  "Remove from team" in their window), asked for in place of turning the
  account off. Their `stylists` row is switched off first, not deleted:
  appointments keep their name, and a stylist with no login would otherwise
  count as bookable. It is also marked `removed_at` (022, also in
  ensure-schema): with the login gone the row has no `staff_user_id`, which is
  what a stylist without a sign-in looks like, so until 2026-10-16 the person
  just removed came back on the next load of the Team list. `listStandalone`
  leaves removed rows out. A stylist without a sign-in can be removed the
  same way (`st_<id>`, which used to be refused). ensure-schema also marks
  members removed before the column existed: any switched-off row with no
  login whose slug is not one of the salon's own (`GOOGLE_OPTIONAL_STYLISTS`).
  `tests/team-remove.integration.test.js` drives the real handler. Sessions and calendar tokens go with the login; booked-by
  and approved-by links become empty. Only an owner can remove an owner, and
  nobody can remove themselves.
- Appearance is per browser (`localStorage` `ss-theme`), applied in the head
  before first paint.
- **Language** (asked for 2026-10-31) sits under Appearance: English or
  Español, per browser (`localStorage` `ss-lang`), and choosing one reloads.
  Spanish is a layer, not a rewrite: the page is still written in English and
  a MutationObserver at the top of the module swaps whole phrases from
  `I18N_ES` (exact text) and `I18N_ES_RX` (counts, greetings, server dates)
  as they reach the screen, text and placeholder/title/aria-label alike.
  It never touches what somebody typed (inputs, textareas, `[data-no-i18n]`,
  your own chat bubbles), names, notes or emails. A phrase not in the
  dictionary simply stays English: add it there, by its exact English text,
  rather than translating at the call site. Dates use `LOCALE`; the salon
  clock's `Intl.DateTimeFormat('en-US')` stays English because code parses
  it. Karen says hello in Spanish (`kHello`), and her AI answers in Spanish
  because the page sends `lang: 'es'` to `/api/staff/karen`, which
  `karen-desk.js` turns into one line of her prompt. Texts and emails to
  clients are not translated.
- Nav and buttons follow RocketOS's restraint on Synergy colours. The ring
  under the current page is a still gradient edge (`--ring-grad`) around a
  2px glass inset, sprung by motion's `animate()` at stiffness 300, damping
  20, mass 0.8, measured in `requestAnimationFrame` (`moveRing()`); no glow,
  no spin. Primary buttons use `--cta-grad` and `--cta-shadow`, hover is
  opacity .9, and only the page's one primary carries `--cta-glow` (capped at
  RocketOS's gold-glow strength). Ambient page light stays at about 5%.
- The salon's logo is a chip of its own left of the menu pill (2026-10-26;
  briefly on the right that day); it used to be inside the pill. Under 640px it is
  hidden so the menu fits a phone. The client profile has no header Edit
  button: each card's pencil edits in place. On Home under 760px the two
  figure tiles (`.hm-num`) stay side by side, half each.

- **The client profile, 2026-11-03** (asked for): the appointments (Appt.
  Book) come first, then Contact details; the Tags and status card is gone.
  The header carries the status (a native `<select>` styled as a chip,
  because the app's pop-up menu draws under a modal dialog's top layer),
  Card on file, and the client's **tags** (`contacts.tags`, migration 041,
  also in ensure-schema; `PATCH {op: 'tags', tags: [...]}`, `setTags`: up to
  20, 30 characters each, duplicates dropped whatever their capitals). The
  plus (or pencil once there are tags) opens an editor in the header:
  removable chips, a box (Enter or comma adds), a chip clicked goes back in
  the box to be renamed, Done. Each change saves as it is made.
  **Activity** filters are All, Appointments, Email, SMS and **Admin**
  (was Automations, which never had anything; Forms went too). Admin is
  `contact_changes` (041): every change the team makes to a client's record,
  field, old and new, who and when, written by `logChanges` from the edit
  form's save (name, phone, email, status, source, notes, diffed so a save
  that changes nothing logs nothing), Add note, the preference switches,
  Card on file and tags. Older changes were never recorded. "Added as a
  contact" reads "Client Created"; every booking reads "Appointment Booked"
  (`bookedLabel` still says who, for Karen's tools); no event shows a ref,
  each event of a visit shows the visit's own date (`apptAt`). Every line
  carries `by` (`bookedBy`, `staff()` in `contactDetail`): Karen, a team
  member (their face from `people`, the photos `contactDetail` returns once
  each), the client (website), an automation by its name, "The team" where
  the app knows the desk did it but not who (check-in, done, no-show), or
  nothing where nothing recorded who (a cancellation). Automated emails and
  texts are titled with their automation (`AUTOMATION_NAME` in contacts.js,
  the names the Automations list now uses too, in Title Case: Appointment
  Booking, Appointment Reminder, Reschedule Notice, ...), the subject beside
  the visit; a direct email by its subject, its writer from the body's
  `fromName`. The message box starts on **Text** (blue) every time, Email is
  red: the switch, the box's edge and "Send text"/"Send email" take the
  colour (`--pc`; Text blue and Email red since later that day). Each of
  the two buttons keeps its own colour on hover, light blue for Text and
  light red for Email, whichever is chosen (`--own`). `tests/client-changes.integration.test.js`,
  `tests/staff-profile-ui.test.js`.
- **The second round of 2026-11-03** (asked for):
  - The ticket: the close button on the name's line; No Show, Cancel Appt.
    and Move Appt. small, with Check in (Done once in, Reopen when
    cancelled) filled at the same row's right end (`.tkt-main`, moved there
    from the top left on request), above a divider, then the details; "Delete Ticket" as red
    words bottom left. No "Open client": the client's name is the button
    (`.ad-name`, `data-ad="client"`).
  - Dates of a visit read "Today, Nov 3", "Tomorrow, Nov 4", else "Wed, Nov
    5" (`dateLabel`): the move confirmation, the Move window, the ticket's
    When and Next appt, and the Activity's appointment line. The move's two
    choices are "Send the Client a Notification" and "Just Move the
    Appointment".
  - Appt. Book: the day's date and count are two lines at the right of the
    toolbar's row; each column header has a scissors icon, not Google's
    mark; a card is the service small in capitals with the time, the
    client's name, their phone (the booking's, else the client's, from
    diary.js), and its status marks in the bottom-right corner.
    Since 2026-11-06 (asked for) a card is headed by its exact time on the
    left, start and end ("9:00 AM - 10:00 AM", `cardTime`, `exactClock`),
    from the same minutes that place it on the grid; the service follows
    across the card's whole width (beside the time it was cut short). Each
    part of a visit with a processing break shows its own start and end; a
    short card shows the start beside the name; in a narrow column the end
    wraps under the start. Cards start 1px under their minute and stop 5px
    short of their end (`cardH`, the drag ghost and the dropped card
    alike), so back-to-back visits never touch. Week and Month follow
    (same day, after "I still can't see it": Appt. Book reopens on the
    view last used, and those draw chips of their own): Week's chips lead
    with the exact start and end (`cardTime`), Month's with the exact start
    ("10:00 AM", `exactClock`), and Month's chips have 3px between them.
  - Activity: who did it is a small picture on the bottom-right corner of
    the event's icon (`.tl-badge`, who it was on hover; the name line under
    the event was taken off on request);
    no "Sent" chip (an entry is a sent email; Failed is still marked); the
    website form's line reads "Client Created"; an automation's email shows
    the visit, not its subject line. Manual messages: Text blue, Email red.
  - The nav bar and logo chip are 24px round, so their corners run parallel
    to the 18px ring inside. Money has no Billing card.
- **A move redraws in place** (2026-11-03): `refreshDiary()` is quiet by
  default (`loadDay(..., {quiet, force})`, `loadMonth(..., {quiet})`), so a
  move, a check-in or a block no longer wipes Appt. Book to a skeleton and
  jumps to the top. A dragged card moves to where it was dropped as soon as
  the move is confirmed (its Finish part hidden until the redraw), and the
  quiet redraw puts everything where the server says.

- **Onboarding and who sees what** (asked for 2026-11-03).
  **Onboarding.** Somebody added to the team (by the owner, or approved
  after asking to join) completes their own account before the app opens.
  `staff_users.onboarded_at` (migration 042, also in ensure-schema): added
  with `DEFAULT now()` so everyone already on the team counts as done, then
  the default dropped, so every row inserted after is NULL (re-running
  either statement fills nothing). `needsOnboarding` in auth.js: NULL and
  not `canManageTeam` (owners and admins are never held). `requireStaff`
  refuses such a person with 403 and code `ONBOARDING` everywhere except
  the endpoints that pass `{ onboarding: true }`: `/me`, `/profile` and
  `/calendars` (and the Google sign-in, which uses `currentUser`). The
  console's `api()` turns that 403 into the setup screen (`#onboard`,
  `showOnboarding`, `obPaint`), led by Karen (2026-11-03, redesigned the
  same day on request as a guide rather than a chat bubble): her own panel
  beside the form from 900px (`#obGuide`, sticky), a band above it on a
  phone. She types what she says (`obSays`, a caret, her clip and three
  talking bars while she does; read whole by `#obSayLive`; still for
  reduced motion), lists the steps and a checklist for this one (`#obPath`,
  `#obTodo`), and rings the next thing to do on the form (`.ob-hl`, from
  `obGuide()`: each step's items, done or not read from the form as it is,
  required ones first, then the step's button; the field in use is ringed
  while it is and she says what it is for). On a phone her tip sits under
  that field (`#obTip`) instead of resizing her band. Refusals are said by
  her too. The picture is **Upload a photo** (with the crop) or **Choose an
  avatar**, the Team window's own `#picDlg` through `openPicFor(take, ...)`
  (`picFor` set, so the choice goes to the setup and not to `memberPic`).
  Step 2 is the Team window's own services control (asked for
  2026-11-03): `#memberSvcs` moved into the form (`#obSvcSlot`) and back
  home before the form is redrawn (`obSvcsHome`), painted and read by
  `paintServices`/`readServices`, so a kind switched on opens to its
  services and one switched off folds to a line, exactly as in Team and My
  Settings; Back keeps what was typed (and saving Step 1 again does not
  replace it with the stored copy). On a phone a kind switched off is one
  line everywhere (`.svc.off > .svc-f`).
  Step 1 who they are and what they do: picture, name, mobile
  (required for a stylist, as everywhere: Karen knows them by it), their
  role (shown) and their title (`staff_users.job_title`, migration 043,
  also in ensure-schema, copied to their chair's `title` for the website;
  required for a stylist), Step 2
  for a stylist their services, prices and minutes (at least one on),
  then their hours, Connect your calendar (optional, "Skip for now") and
  Review & Finish.
  **Reworked 2026-11-04** (on request): a stylist has five steps, About
  you, Services & Pricing, Hours & Availability, Calendar, Review & Finish;
  anyone else About you, Calendar, Review. Everything saves as it is
  typed (`obQueueSave`/`obFlush`, 0.9 s after the last keystroke, one save
  at a time and each reading the form when its turn comes, or two would
  both add the same new service), with "Saving…"/"All changes saved" under
  the buttons (`#obSaved`) and **Save & continue later**. The step they are
  on is saved too, `staff_users.onboarding_step` (migration 044, also in
  ensure-schema; `onboardingStep` on `/profile`, cleared on finish), so a
  reload, a closed tab or signing in again resumes there; it used to start
  at step 1 every time. A copy of About you and the step sits in
  `localStorage` (`ss-ob-<email>`) only as a backup for what the server
  does not have. Steps already reached reopen from Karen's list and from
  Edit on the review; Back and a jump keep what was typed (`obKeep`) even
  if it cannot be saved yet. Continue checks the step and puts each
  message under its field (`.ob-err`, `aria-invalid`). The Hours step is
  My Settings' own hours control (`#memberHoursWrap`, moved in and home
  like the services); the stylist sets their own hours and the owner sees
  and changes them in Team, as decided on 2026-10-15. The server now
  refuses `finishOnboarding` for a stylist until their chair offers a
  service and has hours (`ONBOARDING_SERVICES`, `ONBOARDING_HOURS`), on top
  of name and mobile. "Fields that cannot be filled" was never reproduced;
  the likeliest cause was greyed boxes: a kind's Price and Minutes are
  disabled until its switch is on, and tapping one did nothing. Now the tap
  switches the kind on (a day's times likewise), the role box says it is
  set by the owner, and the phone box formats with `phoneAsTyped` (it used
  `usPhone` on every keystroke, which put the caret at the end and a
  deleted bracket straight back).
  **Hours take up to three time slots a day** everywhere the control is
  (onboarding, My Settings, Team): "Add hours", a remove button, and a
  message on the day for an empty, backwards or overlapping slot
  (`dayProblem`, `hoursProblem`); the server always took several
  (`readHours`, roster.js).
  **A stylist's own services** (2026-11-04): "Add a service" under the four
  kinds, in onboarding and My Settings: name, kind, optional description,
  price and minutes (both required), on or off. They are rows in
  `services` with `owner_staff_id` (migration 045, also in ensure-schema,
  no foreign key on purpose) and an `own-<id>-<name>` slug, and their
  on/minutes/price live in the stylist's `services.items` like every other
  figure (`ownPrice` in timing.js now reads an item's price first).
  `serviceIdsFor` in roster.js offers one only with its owner, whatever
  kinds anybody else has on, and whether or not the owner's own kind is
  on. A name already on the salon's list or theirs is refused. Dropping
  one, or removing the stylist from the team, switches it off rather than
  deleting it (appointments point at it). `/me` lists them with `owner`
  (the owner sees everyone's, anyone else only their own); the Team window
  shows them as "Their own services" (switch, price, minutes; no add).
  `tests/onboarding-progress.integration.test.js` covers the step and the
  services. The onboarding text is not translated for the Spanish setting
  yet. On finish the app reloads and Karen flies from the
  middle of the screen into her Call Karen button (`karenFlyHome`, through
  `sessionStorage` `ss-karen-home`; a toast alone for reduced motion). The
  setup link is emailed and, since 2026-11-03, texted from Karen's number
  to the mobile the owner typed (`textInvite` in sms-notify.js, on add and
  on Resend; skipped without Twilio or a number, never failing the add;
  `invite.texted`), so they can finish on their phone. The
  Team list marks them Invited (link not used yet), then Setting up.
  **Salon Settings are the owner's** (2026-11-03). Anyone else, Dina
  included unless she holds the Owner or Admin role, has Settings, My
  Settings only: the tab bar is hidden, `showSetting` sends any other tab
  (typed, bookmarked or linked) to My Settings, and `go()` does the same
  for the Automations, Email History, Team (`/account`) and calendars
  addresses. The server agrees: `GET /api/staff/team` is 403 for them,
  `/api/staff/business` (the salon profile and its save) needs `seesAll`
  except one sent email of their own client, Karen's settings (`GET
  /api/staff/karen`) are `requireTeamAdmin`, and booking calendars are
  managed by Owner or Admin only. Clients' "Choose your stylist" is shown
  to the owner only. **My Settings holds your own services, pricing and
  hours** (`#myWorkCard`): the Team window's `#memberWork` block is moved
  into it (`workTo('self')`, back with `workTo('dialog')` when the owner
  opens somebody else) and saved by `PATCH /api/staff/profile`, which now
  keeps the hours you send (`readHours`): everyone sets their own
  available hours, and the owner still sees and changes everyone's in
  Team, so a wrong one is visible. Hours belong to a chair, so they are
  kept only once a service is on. The card is compact (asked for 2026-11-03): two
  tabs, Services & pricing and Available hours (`#mwTabs`,
  `#myWorkSlot[data-mw]`), one shown at a time; in it the long
  explanations and the Price/Duration labels are hidden, an opened kind's
  services sit two to a row, the days are one bordered list, and on a
  phone a kind or a day switched off is a single line. All of it is CSS
  under `#myWorkSlot`, so the Team window is unchanged.
  **Who sees what.** Only the owner (`canManageTeam`: role Owner or Admin,
  or the support login) sees everyone's calendar, appointments and clients.
  Everybody else, stylists included, sees only their own chair (the
  `stylists` rows linked to their login), its appointments, the clients in
  their book (booked into their chair at least once, or added by them) and
  their own account. One rule, `api/_lib/scope.js` (`seesAll`, `chairOf`,
  `clientInChairSql`, `assertClientInChair`, `bookableSlug`), used on the
  server by diary.js (appointments, blocks, hours, their own Google column
  only; blocks only on their own chair), appointment.js (ticket, times,
  every action and move: anything else is 404), availability.js and book.js
  (their own chair only), home.js (figures, Coming up, charts; the tiles
  read "My Appts." for them), contacts.js (list, profile with only their
  chair's visits, every change, delete), team.js (themselves only), me.js
  (stylists and team lists), business.js (Email History, Sent History, the
  automations' counts, Finance: the owner's; one sent email opens for the
  stylist whose client it went to), Karen in the app (karen-desk.js tools,
  karen-actions.js proposals) and Karen by text (`chairAhead`, the schedule,
  `deskBook` and the stylists she offers: their own chair; the owner the
  salon). The console hides Money and Automations from them. A team member
  with no chair (front desk) sees no appointments at all: that is what the
  salon asked for, and the place to change it is `seesAll`.
  `tests/onboarding-access.integration.test.js` drives the real endpoints.
- **Inviting a team member, led by Karen** (asked for 2026-11-04).
  Add Team Member opens its own small form (`#invNewDlg`,
  `openInviteNew`): Name, Phone number, Email, Role and **Send
  Invitation**; the phone is asked of everybody, since the welcome text
  goes there. The big team window (`#memberDlg`) is now only for editing.
  Sending creates the account as before (`action: 'create'`, the drawn
  default picture saved with it) and `deliverInvite` in team.js sends
  Karen's welcome both ways and says what came of each (`emailed`,
  `emailFailed`, `texted`, `textFailed`, `hasPhone`, `off`). The window
  that follows (`#inviteDlg`, `showInviteLink`) reads "<name> has been
  invited", Karen waving (her clip, looped while it is open) with "I'll
  take it from here!" typed in a bubble, then a row each for the welcome
  email, the welcome text and the account setup, ticked or not and why.
  The link is shown only when neither went. An unused invite can be sent
  again from the person's window (**Resend invitation**, `reinvite`,
  which mints a fresh link). The welcome email (`welcomeContent` in
  email.js) is Karen introducing herself and the app, who invited them,
  the button, and the four steps she then leads; the text
  (`inviteText` in sms-notify.js) is plain GSM-7, two segments with the
  link. **The Team Member Invitation automation** (kind `team_invite`,
  `INVITE_KIND`) is in Settings, Automations with the twelve, its switch
  in `automations_off` like theirs: off, neither is sent and the owner is
  handed the link. It is not in `MESSAGE_KINDS` (the queue and the
  client's Activity deal only in guest messages): business.js lists
  `AUTOMATION_KINDS`. The email is logged in `message_sends` (kind
  `team_invite`, no appointment, no client) with the facts it was written
  from in `body`, **never the link**: Email History lists it and opens it
  rebuilt with the app's address on the button (`previewInvite`). The text
  is logged in `team_texts` (migration 046, also in ensure-schema; not
  `client_texts`, whose client is required) with the link replaced by
  "[setup link]", and the automation's Sent History merges both. A client
  who shares the address never sees it on their Activity (contacts.js and
  Karen's tools leave `team_invite` out). Karen meets them on the
  password page too (`#pwKaren`: her clip waving once, what to do, and
  how many characters are still needed), which now has the salon's logo
  (`#inviteMark` was an empty box). **Setup changes**: no title field (the
  server still takes one, nothing asks), no avatars (the photo window
  opens straight on the file chooser with `uploadOnly`; the face has a
  camera badge, and "Your photo" is ticked only for an uploaded one,
  `obHasPhoto`). About you also shows their **email** above the mobile
  number (2026-11-04), prefilled from the invitation and editable: it is
  their sign-in, so only a whole address that changed is saved
  (`OB_EMAIL`, `PATCH /profile {email}`, which refuses one another team
  member already uses). **Prices are per service**: each kind's services list has
  Price beside Minutes (`data-it="price"`), saved as
  `services.items[slug].price`, which `ownPrice` already read first; the
  kind row has no price box and saves `price: null` (a kind with no
  services on the menu keeps what it had, `data-price`). A kind's old
  price is shown in each of its services until they are given their own,
  so nothing priced before is lost. The same control is in Team, My
  Settings and onboarding; on a phone each service's name has its own line
  with price and minutes under it. **Lunch break** reads "Flexible" under
  its title. **Google Calendar** has its own logo (`GCAL_LOGO`; Google's G
  stays for signing in) on the tools card and the onboarding step; once
  connected the button is green with a tick and "Connected" (`.gcal-ok`),
  The onboarding step shows the logo once, centred on the card with
  "Google Calendar" and its status under it (no logo on the button, no
  explanatory lists: both taken off on request), one main Connect button,
  and Skip for now as the quiet way on (`.ob-skip`);
  the account in green under the name, and Disconnect a quiet link.
  `tests/team-invite.integration.test.js` drives the invite through the
  real handler with stand-ins for Resend and Twilio.
- **Resend Invitation follows where they are** (asked for 2026-11-04).
  It used to send the first welcome again word for word, and refused
  anybody who had chosen a password but not finished, who then had no way
  to be reminded. `reinvite` in team.js now reads their state: a link never
  used (or run out) gets Karen's reminder with a fresh link (`stage:
  'invite'`; minting it ends the old one); a password chosen with setup
  unfinished gets Karen's "you're almost there" reminder (`stage:
  'finish'`) with the app's address and the step they stopped at
  (`onboarding_step`, `SETUP_STEP_NAMES`), never a link that sets a
  password; finished is refused, nothing to resend. Both are
  `reminderContent` in email.js and `inviteText({stage})`, from the same
  sender as the welcome, logged as `team_invite_reminder` (Email History,
  and the Team Member Invitation automation's new Reminder Message step
  and its Sent History) under the same switch. The button shows for
  Invited and Setting up; the window says "Invitation resent to" or
  "Reminder sent to", Karen saying "I'll give them a friendly nudge!".
  The Team list reads **Invite expired** once an unused link runs out
  (`inviteExpired`), and Setting up says the step on hover. A dead link
  says it may have been replaced or already used, and offers Sign in
  (`INVITE_DEAD`). `tests/team-resend.integration.test.js`.
- **The invite link remembers their progress** (asked for 2026-11-04).
  Choosing the password used to spend the link, so clicking it again
  halfway through setup said it had expired. Now its hash moves to
  `staff_users.setup_hash` (migration 047, also in ensure-schema) and
  `GET /api/staff/invite?t=` answers `{resume: true, step}` for it until
  setup is finished (`onboarded_at`, which clears it). It grants nothing:
  POST refuses it (`INVITE_RESUME`) and it never makes a session, because
  the link sits in email and texts. The page (`showInvite`) then opens
  setup straight at the saved step when this device is still signed in as
  them, else the sign-in page with their email filled in and "Karen kept
  your place ... she'll take you back to <step>"; signing in lands there
  through `onboarding_step` as before. A link replaced by Resend is still
  dead. Covered in `tests/team-resend.integration.test.js`.
- **The round of 2026-11-04 afternoon** (asked for):
  - **Appt. Book shows only team members on the team with a calendar.**
    diary.js reads `shown` per visit (stylist not `removed_at`, linked to a
    login, `GOOGLE_CONNECTED_SQL` true) and returns only those, Day, Month
    and counts alike, after placing the flexible lunch from every booking.
    The rows are untouched: tickets stay on each client's profile. The
    console no longer makes "Not connected" or "Removed from team" columns;
    the remove window's "Remove anyway, keep their tickets" says so. This
    hides the four stylists without a sign-in (Dina, Micah, Tami, Kim) from
    the book until they have a login with a calendar.
  - **Invited** is a yellow chip (`.chip.invited`), Setting up periwinkle.
  - **Karen in the team's emails smiles** (asked for 2026-11-04, later): the
    picture is the frame at 5.0s of `karen-wave.mp4` (smiling at the reader,
    hand open), cut to the same 192px circle and periwinkle ring, in place of
    the clip's first frame, whose mouth is flat. The line under the greeting
    reads "(813) 555-0199 · Synergy Salon's Assistant" (her name dropped on
    request: the greeting says it), the number from `tenants.karen_phone`
    (`shopFrom().karenPhone`, written as the salon writes numbers by
    `usPhoneText`, a `tel:` link); without a number it is "Synergy Salon's
    Assistant".
  - **Karen's hello after setup** (asked for 2026-11-04): once Karen has
    flown into her button at the end of onboarding, a bold bubble with a
    soft periwinkle glow is pinned to the Call Karen button (under it on a
    computer, above it on a phone, its tail pointing at her): "I'm right
    here if you need help! Just click my menu to chat with me."
    (`karenHelloBubble`, `.k-hello`; it replaced a toast at the foot of the
    page). Pressing it opens her chat; its cross, Escape or opening her any
    other way dismisses it. Shown once, with no animation for reduced motion.
  - **Karen's emails carry Karen and the wordmark**: `karenImages` in
    email.js, from the salon's own site (`/assets/karen/karen-email.png`, a
    192px PNG already cut to a circle with her ring, because Outlook ignores
    border-radius and not every client shows webp; and the console's
    wordmark `7c1e4b2a…png`), beside the greeting in a table. The team's
    emails use the wordmark rather than `tenants.logo`, whose live address
    drew a broken picture. Left out with no `https` site (tests).
  - **No length on a kind of service**: each service has its own minutes
    beside its price. A kind's old Duration is carried into each of its
    services with none (`mins`), the row keeps it in `data-dur`, and it is
    saved only for Color (the server reckons Color from its parts) or a kind
    with no services on the menu.
  - **Add client**: a duplicate is the same name (trimmed, any case) with the
    same email or phone; a different name sharing one is added. The old rule
    refused "Marian Test" for sharing Fulano Detal's email, and a stylist
    could not even see Fulano. Editing follows the same rule.
  - **Stylists in Settings** (anyone but `canManageTeam`): the tab bar shows
    My Settings, Team, Automations, Money and Karen AI; Salon is the owner's
    (`showSetting`, `go()`; calendars stay the owner's). **Team** is a
    roster (`GET /api/staff/team` answers `{roster: true}` with name, role
    and picture only; `renderRoster`, greyed, not clickable). **Automations**:
    each switch is their own, for their own clients (`staff_users.
    automations_off`, migration 048, also in ensure-schema; `PATCH
    /business {automation, on}` writes theirs; `sendMessage` skips a visit
    whose stylist turned it off, `stylistOptedOut`, so queued sends obey
    it); one the salon turned off reads "Off for the salon" and is
    disabled; the team's own invitation is not listed; Sent History and
    Email History are their own clients only (`mineSql`: a visit in their
    chair, or with no visit a client in their book). **Money**: My income,
    Finance scoped to their chair (`own: true`); **Cash out**: an amount and
    a note (`cashout_requests`, 048; `PATCH {cashout}`; the salon's inbox is
    emailed, `sendCashoutNotice`); the owner sees Cash-out requests in
    Money with Mark paid or Decline (`PATCH {cashoutId, status}`, owner
    only). The app moves no money. Subscription stays the owner's. **Karen
    AI**: read-only, her number, their own Chat History (`history=people`
    cut to themselves, another's refused) and their clients' calls
    (`karenCalls({chair, userId})`). `tests/stylist-settings.integration.test.js`.
  - **My services, pricing & hours** is folded each time My Settings opens
    (`setMyWorkOpen(false)`), opened from its header.
- **Dina's calendar, the tab title and phones** (asked for 2026-11-04).
  - **Why Dina's calendar failed**: her Owner login's Google account had
    never set up Google Calendar, so every read answered 403
    `notACalendarUser` ("The user must be signed up for Google Calendar"),
    seen in production logs on every load of Appt. Book, while the app
    showed her as Connected. Now: the OAuth callback checks a fresh token
    can read a calendar (`checkCalendarAccount`) and refuses one that
    cannot, saying to open calendar.google.com once with that account or
    connect the one they use; a read that fails that way is recorded in
    `staff_users.google_problem` (migration 049, also in ensure-schema;
    `noteProblem` in google.js, cleared by the next read that works, by
    reconnecting and by disconnecting), and `googleStatus` carries it as
    `problem`, so the tools card reads "Needs attention" with Reconnect and
    the Team list's Calendar box says the same. Her Appt. Book column says
    what is wrong instead of "Google did not answer". **Her existing
    connection heals by itself** once she opens calendar.google.com with
    that Google account; otherwise she reconnects with the right account.
  - **A login and its chair without a login** (`chairLoginSql`,
    `chairLoginJoin` in google-busy.js): a chair with no `staff_user_id`
    belongs to the active login with the same first name, when that login
    has no chair of its own and no other chair without a login shares the
    name. Dina again: Owner logins get no chair (her services would vanish),
    and her bookable chair is the separate "Dina Lara". Used by Appt. Book
    (her column's `stylistSlug`, so clicking it books with her chair, and
    `shown`, so that chair's visits are on the book), online availability's
    Google busy time (google-busy.js), the Google copies of bookings
    (google-mirror.js) and blocks. `tests/chair-login.integration.test.js`.
  - **The tab title is "Synergy Salon" on every page** (public pages, the
    bundles' templates as well as their static heads, join, shop, the
    manage page and the console, whose `go()` no longer adds the page
    name). A new export brings the old titles back: re-apply.
  - Popups that cap their height with `100dvh` have a `100vh` line first,
    for older iPhone Safari, which drops the whole declaration otherwise.
    Every page and popup was checked at 360, 390 and 768px with nothing
    running off the screen.
- **A removed stylist's clients are handed on, never stranded** (asked
  for 2026-11-04, after a removed "Luis Lara" still held booked clients).
  Removing keeps the chair (switched off, `removed_at`), so appointments
  never lose their stylist; what was missing was a decision about the ones
  still to come. Now `delete` on `/api/staff/team` is refused with code
  `HAS_APPOINTMENTS` and the list (`guardUpcoming`) while the person has
  booked visits that have not started, until the owner gives `reassignTo`
  (a stylist's slug) or `keepAppointments: true`. `reassignChair` moves
  each visit to that stylist at its own time through `moveAppointment`,
  the desk's move (service offered, hours, the no-overlap constraint;
  `notify` as the move window's choice); one that cannot move stays put
  and comes back with why, and then nobody is removed
  (`REASSIGN_INCOMPLETE`). Past visits stay with whoever did them. The
  console asks in `#reasDlg` (`openReassign`), pre-choosing a stylist of
  the same name (the same person re-added). A chair already removed shows
  on Appt. Book as "Removed from team" (`stylistRemoved` from diary.js)
  with **Move appointments** for the owner (`action: 'reassign'`, and
  `'upcoming'` to list them). HttpError can carry `extra` into its reply,
  and the console's `api()` keeps `code` and `data` on the error.
  `tests/reassign.integration.test.js`.

- **The round of 2026-11-05** (asked for):
  - **Payroll is real, through Stripe Connect.** Money's "Cash out" card is
    now **Payroll** (`#cashCard`, `renderPayroll()`), and the separate
    "Payroll · Coming soon" card is gone. It shows the balance of earned
    income with a $ ("Earned Income" under it) and a **Cash Out** button:
    a window with **Cash Me Out** (the whole balance) and **Partial
    Cashout** (a second window, amount typed, slid or 25/50/75%/All, also
    Cash Me Out). `api/staff/_routes/payroll.js` (`/api/staff/payroll`,
    through the staff router, no new function) and `api/_lib/stripe.js`
    (plain REST, no SDK). The balance (`balanceOf`) is the booked value of
    the person's kept visits that have started, in their chair, less every
    cash out paid, processing or still a manual request. A cash out locks
    the person's row, checks the balance and writes the row as
    `processing` before Stripe is called (two taps cannot spend it twice),
    sends a transfer to the account **stored on their login** (never one
    the browser names) with the row's id as the idempotency key and
    `transfer_group`, reads the transfer back and marks it `paid` only if
    amount, currency and destination match; a Stripe refusal is `failed`
    and the money returns to the balance; a lost answer stays `processing`
    and `settleStuck` looks it up by group (never re-sends) when Payroll
    next opens. The dollar confetti (`dollarBurst`, none for reduced
    motion) waits for that verified reply. Each stylist connects their own
    Stripe Express account from the window (`action: 'connect'`, Stripe's
    own onboarding; it returns to `/settings?tab=money&stripe=return`).
    Migration 050 (also in ensure-schema): `staff_users.stripe_account_id`,
    `cashout_requests.stripe_transfer_id` and `error`, and the states
    `processing` and `failed`. **Needs `STRIPE_SECRET_KEY` in Vercel and
    Connect switched on in the salon's Stripe account**; until then Payroll
    says payouts are not switched on and nothing can be cashed out. The
    salon's Stripe balance must hold the money or Stripe refuses
    (`balance_insufficient`, said plainly). The balance is 100% of the
    booked price: if the salon pays a commission, that rule belongs in
    `balanceOf`. Old manual requests still show, and the owner can still
    mark them paid. `tests/payroll.integration.test.js` runs every path
    against a stand-in Stripe, the race included.
  - **Email History is on Karen AI** (`#mailCard` under Chat and Call
    History); `/marketing/history` opens it there. Automations is the list
    only.
  - **Need Help?** on a client's window (`#pxHelp`, Karen's picture) opens
    her chat already holding that client (`openKarenForClient`: the
    contact for a booking, and a first exchange naming them for her AI),
    with Book, next appointment and reminder chips.
  - **Appt. Book's bar**: Today, back, forward and a calendar button (the
    browser's date picker, `#pickDay` over a hidden `#dayPicker`) on the
    left, the date written out ("Thursday, 5 November 2026", `longDate`)
    and the count under them (`paintWhen`); **Day, Week, Month** on the
    right. **Week** is new (`loadWeek`, `renderWeek`): Sunday to Saturday
    from the month's own data (two months when it crosses), the month's
    cells and chips, so open, add and drag to another day work as there;
    one row per day on a phone.
  - **Later on 2026-11-05**: the calendar button opens the console's own
    picker (`#dpPop`, `openDayPop`/`paintDayPop`, laid out as the salon's
    Google Flights reference: the chosen date in a field on top with Today,
    this month and the next side by side, Sunday first, arrows at the
    sides, Done at the foot; one month under 640px; arrow keys, Enter,
    Escape, double click). `#dayPicker` is now a hidden input that only
    holds the day. Day/Week/Month is a dropdown (`#viewSel`), no longer
    three buttons. **Karen wears a black coat and a purple shirt**: only
    the clothes were recoloured, frame by frame, in the still, the waving
    clip and the email picture (shading kept, face, hair, hand and the
    276-frame loop untouched). They are new files, `karen-still-v2.webp`,
    `karen-wave-v2.mp4`, `karen-email-v2.png`, because `/assets/` is cached
    as immutable for a year and the old names would have kept the orange
    coat in browsers; `karen-email.png` stays for emails already sent.
  - **No "Haircut"**: the generic service is switched off (migration 051,
    also in ensure-schema), so Cuts is Women's, Men's, Teen, Kids' and the
    Bang Trim, as the website survey already had it; the pages' service
    lists and JSON-LD dropped it too. The integration tests book Women's
    Cut where they booked Haircut.
  - **Later the same day** (asked for):
    - (Appt. Book's Day/Week/Month dropdown was asked for in the same
      round; it is `#viewSel` from #110, above, not a second one.)
    - **Email History is laid out as Chat and Call History**: `#mailCard`
      is a third `.kx` box inside `#kaHistory` on the Karen AI card (it was
      a card of its own under it), with the envelope mark, the same header,
      and one row a send in Call History's `kc-row` (name, kind and address,
      time on the right, Failed when refused). Search and the kind filter
      are kept.
    - **No hover on a team member**: the Team list's rows no longer lift,
      shade or show the pencil under the pointer; a click still opens them.
    - **The Cash Out window says what the balance is made of**: earned from
      N completed services, less already paid out and on its way, equals
      ready to cash out; then every service behind it, newest first, with
      its date, what it was (each line of a visit of several services),
      the client and what it earned ("No price" for an unpriced one, which
      adds nothing and is said under the list). `earningsOf` in
      `payroll.js` (on `GET /api/staff/payroll` as `earnings`) and
      `balanceOf` share one clause (`EARNED_FROM`), so the list cannot add
      up to anything but the balance; the newest 1,000 are listed and the
      totals count all. The payroll test checks the two agree.
    - **The client window's status chip has no arrow**: it sat outside the
      native list, so pressing it did nothing. The chip still opens the list.

- **The service menu, 2026-11-05 (evening)** (asked for). Migration 052
  (also in ensure-schema): **Cuts** lose Teen Cut; **Treatments** gain
  Condition Treatment and Mask Treatment, and Bond Repair is one service,
  "Bond Repair: Olaplex & K18" (the survey's separate Olaplex and K18
  choices are one now); **Color** loses Highlights & Foils and Color & Cut
  and gains **Partial Highlights** and **Full Highlights**, keeping
  Balayage, Single Process Color, Biolage Highlights, Gloss or Toner and
  Corrective Color; **Styling**: Bridal Styling is off and Special Event &
  Updo is renamed **Updos** (slug `special-event` kept), Extensions is
  renamed **Consultation** (slug `extensions` kept). Switched off, never
  deleted. New services were linked once to everyone who offers their kind
  (guarded so a stylist's untick is not undone on the next cold start).
  **Color's three fields** above its services: Color, Partial Highlights,
  Full Highlights, each Start, Break, Finish and its total under one header
  (`timeRow`, `.tr-h`). Full Highlights is the set that was "Highlights"
  (still `color.highlights`); Partial is new (`color.partial`,
  `servicesFrom`). Partial and Full are services too, so their tick and
  price sit on their row (`FIELD_SVCS`, read as `.svc-it`) and they are
  not repeated in the list. timing.js: `timingKey` gives `partial` for a
  partial highlight (its figures, else the Full ones), `highlights` for
  every other highlight, balayage or foil. The rows lay out by the card's
  own width (`container-type`), stacking under 620px, because the Team
  window is narrower than My Settings. **Available Hours totals**
  (`paintHoursTotals`, `dayMinutes`): each day shows its bookable time
  under its name ("7h 30m available": the slots, less the flexible 30 min
  lunch when at least 30 minutes of the day fall between 11 and 1), and
  the week's total is beside the heading (`#whTotal`) and on My Settings'
  Available hours tab (`#mwHrsTot`). **The website survey matches** in all
  nine pages (Color: Single Process, Partial Highlights, Full Highlights,
  Balayage, Other; Cuts without Teen or Color & Cut; Treatments with Bond
  Repair as one, Condition and Mask; Styling: Blowout, Updos,
  Consultation), and so do `SERVICE_SLUG` there and `SERVICE_BY_LABEL` in
  enquiry.js (old labels still map where a service exists, for cached
  pages), and the pages' service lists and JSON-LD. A new export brings the
  old lists back: re-apply with this list.

- **The agency's login is backend-only** (asked for 2026-11-06: "we want
  to work on the backend, we don't want to be on the team"). A login whose
  email is in `TEAM_ADMIN_EMAILS` (`isAgency` in `auth.js`, today
  support@unclelouieproductions.com) keeps every admin right
  (`canManageTeam`), but `notAgencySql` leaves it out of the Team list and
  roster (it still sees itself), the Clients stylist filters (`/me`'s
  team), Appt. Book's columns and Karen's team roster; it never sees the
  setup screens; `syncStylist` never gives it a bookable chair, whatever is
  switched on; and its My Settings has no services, prices or hours card
  (`me.user.agency`, `body.agency`). Give it the Admin role.
  `tests/agency-login.integration.test.js` drives it, and refuses to run
  where that login already exists.

- **Later still on 2026-11-05**: Available Hours' week total is its own
  row under Lunch break (`.wh-sum`, `#whTotal`, `#whDays`), no longer by
  the heading or on My Settings' tab. The Color row has a **Price**
  (`data-kp="color"`, saved as `color.price`): every Color service without
  its own price shows it as its hint (`data-inherit`, updated as it is
  typed) and is booked at it (`ownPrice`: Partial and Full Highlights fall
  back to it too); the onboarding check counts such a hinted price as a
  price. Service names in the lists wrap rather than being cut, and My
  Settings puts two services to a row only from 440px each, so nothing is
  truncated at 1024px. Checked at 1440, 1024, 768, 390 and 360px in My
  Settings and the Team window for clipped text, overlaps and anything
  outside the card.

- **Shampoo Blowout** (asked for 2026-11-06): a Styling service, between
  Blowout & Styling and Updos (migration 053, also in ensure-schema; 45
  minutes, an estimate like the rest; linked once to whoever offers
  Styling). The website survey's Styling choices, both label maps and the
  pages' service lists and JSON-LD have it too.

- **K18/Olaplex Treatment** (asked for 2026-11-06) is Bond Repair's name
  now (migration 054; slug `bond-repair` kept, so bookings, prices and
  stylists stay). ensure-schema's 052 line, which renamed it on every cold
  start, carries the new name. The survey, both label maps, the pages'
  menus, the Treatments page's heading and the service lists say it too.

## Small screens

Checked on 2026-10-22 at 375, 390, 768 and 1440px against the real console
and API running locally on a test database (every page, New appointment,
the client profile, the automation, message and turn-off windows, Karen):
nothing pushes the page sideways. What was fixed then: under 390px the
profile chip in the nav is its picture alone (a later `.grn-me` rule had
been overriding the 420px padding, so it ran off the edge); under 600px the
month grid has no "+" buttons, since the whole cell already adds and they
squeezed the dates; Home's chart labels thin by the chart's own width
(container query on `.hm-x`). The Appt. Book day grid is wider than a phone
on purpose -- one column per stylist -- and scrolls sideways inside its card
(`#dgWrap`, `overflow-x: auto`).

## Gotchas worth knowing before you hit them

**Untyped query parameters.** `tstzrange($1, $1 + make_interval(mins => $2))`
fails with `42P08` or `42883`: Postgres cannot deduce the type. Cast every
parameter inside a function call: `$1::timestamptz`, `$2::int`. This has bitten
in four places and each time the failure was silent until that path ran.

**Vercel Hobby allows 12 serverless functions.** One file under `api/` is one
function. The staff endpoints live under `api/staff/_routes/` behind
`api/staff/[action].js` for this reason; `_`-prefixed paths are not functions.
The build succeeds and the *deploy* is refused, so watch for a READY build that
never goes live.

**Hobby crons run once a day.** Anything needing to be prompt does the work
inline and leaves the cron as a safety net.

**Supabase keeps extensions in an `extensions` schema.** `schema.sql` sets
`search_path` so the gist operator class is found; without it the exclusion
constraint silently fails to create and there is no double-booking protection
at all.

**Use the transaction pooler** (port 6543). Supabase's direct connection is
IPv6 only and Vercel cannot reach it: works from a laptop, fails in production.

**`\u002F` inside a RegExp literal is a `/`.** The design exports escape
every `</` as `<\u002F` so the outer script cannot close early, but
`new RegExp('<\\u002Fspan>')` matches a literal `</span>` and therefore
never matches the escaped text in the file. This cost an afternoon twice.
Use plain string operations -- `indexOf`, `endsWith`, `slice` -- on the
template, never a regex.

**`[hidden]` loses to any author rule that sets `display`.** The browser's
own `[hidden] { display: none }` is beaten by `label { display: block }` and
`.btn { display: inline-flex }` in the console's stylesheet, so setting
`el.hidden = true` on either did nothing at all and the change looked like
it had not deployed. `staff/index.html` now carries
`[hidden] { display: none !important; }`. Check anything that was relying on
the attribute quietly failing -- the `.gday` rows in Appt. Book will now
actually hide.

**Gmail throws away most of an email.** It strips `<style>` from the head,
so every rule has to be an inline `style` attribute, and it drops `<img>`
whose `src` is a `data:` URI, which is why `shopFrom()` only passes a logo
through when it is `http(s)`. Declare the charset in the document itself
and not only in the MIME headers, or apostrophes arrive as `â€™`.

**A push to `main` has twice produced no deployment at all**, with Branch
Tracking on and no failed build to show for it. Confirm what is live by
fetching the page and counting something you changed, rather than trusting
the dashboard; recover by creating the production deployment from the sha.

## Texting (A2P 10DLC), from 2026-10-27

The salon is registering a Twilio number for texting (account under
support@unclelouieproductions.com; brand "SYNERGY SALON OF TAMPA BAY INC",
campaign Low Volume Mixed: customer care and appointment notifications, no
marketing). What the campaign describes must stay true on the site:

- **`/sms-opt-in`** (`sms-opt-in.html`; `/contact` until 2026-10-27, which
  now redirects there) is the registered opt-in: name, email, an
  optional mobile number, a message, and an **optional, unticked** consent
  box whose wording was registered with the carriers. Do not make the box
  required, pre-tick it, or add marketing to its wording. It posts to
  `/api/enquiry` with `kind: 'contact'` (`api/_lib/contact-form.js`; no
  new function, the project is at twelve): the contact is saved with a
  dated note saying where and how they agreed, `sms_ok` goes on only for a
  ticked box with a 10-digit number, an unticked box never turns a yes off,
  and the salon is emailed (`sendContactNotice`, reply goes to the guest).
  A hidden field and a 2.5-second floor quietly drop bots. A ticked box
  also texts the opt-in confirmation (`optInText`, from Karen's number) that
  carriers require of every recurring programme and that the resubmitted
  message flow (2026-10-27, after rejection 30909) says is sent; it fails
  quietly until the number is approved. Twilio's own opt-in reply (START)
  should read the same. Karen's first reply in a conversation ends
  "<salon name>: Reply STOP to opt out, HELP for help." so every
  conversation names the brand.
- Every page's footer links it ("Contact & Text Updates", beside Privacy
  Policy, 2026-10-27), because the carriers' reviewer looks for the opt-in
  from the site itself and rejected the campaign once ("issues verifying the
  Call to Action") while nothing linked to it. It sits in the design
  template of the six bundled pages, so **a new export drops it**: re-add it,
  or add it in Claude Design.
- **Privacy Policy section 4 and Terms section 11** are the texting terms
  (`#sms`), including "No mobile information will be shared with third
  parties or affiliates for marketing or promotional purposes."
- **Karen** stays silent on a whole-message carrier keyword (STOP, CANCEL,
  END, QUIT, HELP, START and the rest, `isCarrierKeyword`): the provider
  answers those, and "cancel" alone unsubscribes, so she tells people to say
  "cancel my appointment". Her first reply in a conversation ends "Reply STOP
  to opt out, HELP for help."
- `contacts.sms_ok` **defaults to true** (031) and so is not consent. Anything
  that starts sending texts must decide what counts as opted in first.
- The standalone pages (contact, privacy, terms) once pointed at a logo and
  fonts a site export deleted, so the live Privacy and Terms showed a broken
  logo for weeks. They now use the homepage's own files
  (`0502ac51…png`, Geist `fe9fff11…`, Anton `3828f8dd…`); after an export,
  check those still exist.

## Appointment texts, from 2026-10-28

Karen texts a client the confirmation, a move, a cancellation and the
day-before reminder (`api/_lib/sms-notify.js`, from Karen's number, through
`api/_lib/twilio.js`). They ride on the email of the same kind:
`sendMessage` in `email.js` texts first (never throwing), then emails if
there is an address, so the Marketing switches govern both and every place
that books or changes a visit reaches them. A desk booking with only a
phone now goes through `sendConfirmation` too, and the reminder cron picks
up visits with a client but no email.

**Only to a client whose consent is on record** (`contacts.sms_consent_at`,
`_source`, `_phone`; migration 034, also in ensure-schema). The website
opt-in box sets it ("Website opt-in form"); a START/UNSTOP/OPTIN reply sets
it ("Replied START"); STOP and the other opt-out words clear it
(`consentKeyword`, recorded by the SMS webhook before anything else, the
provider answering the keyword itself). Never use `sms_ok` for this: it
defaults to true. The A2P registration says texts go only to people who
opted in on the website, so a client booked at the chair is **not** texted
until the salon adds a "client agreed to texts" box at booking **and** the
campaign is updated to include that method (decided 2026-10-28: after the
first approval). Texts: the salon's name first, "Reply STOP to opt out." last
(`appointmentText`, also what Marketing's preview shows). Follow-ups such
as review requests are never texted: they read as marketing.

## Karen on Claude (Opus 5.5), from 2026-10-27

With `ANTHROPIC_API_KEY` set (Production, since 2026-10-27), texts are read
by `claude-opus-5-5` at low effort (`api/_lib/karen-ai.js`). Since
2026-10-28 that includes **the team**: a stylist texts Karen to cancel or
move a client's appointment (asked for: "Karen manages appointments when
the stylist asks by text"). A stylist sees and changes only their own
chair's next two weeks (`chairAhead`); the admin (`canManageTeam`) the
whole salon's; a team member with no chair, nothing. They book new clients
in the app, not by text. A yes cancels or moves it through the same
functions, leaves a note on the client ("asked by <stylist>"), and the
client gets the usual email, plus a text if they opted in. Calls to Karen's
number still greet and forward to the salon (decided 2026-10-28).
Karen knows a stylist only by the phone on their team profile, so **a
stylist's mobile number is required** (`assertStylistPhone` in profile.js,
enforced by team.js on add, edit and role change and by your own profile;
the team window says so before saving, and a stylist's card reads "Mobile
number needed" in red until it is set). Stylists without a sign-in (the
four kept by slug) have no phone and are not covered.
What keeps it safe is outside the model, so keep it there:

- **The model only proposes.** Its tools look up free times or *propose* a
  booking, move or cancellation; the proposal waits on `karen_threads.state`.
  `smart()` in `karen-sms.js` carries it out only when the client's next text
  is a plain yes (`PLAIN_YES`), through the rules' own `bookIt`/`moveIt`/
  `cancelIt`, and a plain no drops it. **A proposal lives for one reply:**
  anything else drops it, so "no wait, keep it" and a later "yes" cancel
  nothing. Do not let the model's text, or a tool, commit a change.
- Times come only from `availableSlots` (`openTimes`, `stillFree`), checked
  at proposal and again on yes. Appointments are a numbered list of the
  texter's own, so the model can neither name nor reach anybody else's.
- No prices reach it (its service list has none); its rules give the one
  cleared figure, AI scalp analysis $40.
- `alert_salon` emails the reply-to inbox (`sendKarenAlert`, hair@ for
  Synergy) once a conversation, with the conversation in it.
- Every change leaves a dated line on the client's notes.
- The STOP/HELP line on a conversation's first reply is added by code, never
  left to the model. Changes the system made are told back to the model
  ("Done in this conversation"), because without that it read the system's
  "All set!" as its own mistake and told the client nothing had moved.
- If the model fails (error, refusal, timeout at 30s, six tool rounds), the
  rules answer that text.
- **Replies are sent after the webhook returns.** The model takes 2 to 7
  seconds and Twilio gives up at 15, so with the key and
  `TWILIO_ACCOUNT_SID` set the SMS webhook answers empty at once and
  `waitUntil` sends Karen's reply through Twilio's Messages API
  (`sendText`). Without either it answers inline with the rules, as before.
- Tests use a scripted stand-in for Claude (`tests/karen-ai.integration.test.js`):
  they cost nothing and test the guarantees above, not the wording.

## Local setup

```bash
npm install
cp .env.example .env        # then fill it in; never commit it
npm run db:setup            # schema + seed
npm run db:migrate          # anything newer
npm run ghl:link            # verify and store the CENTRO credentials
npm run staff:create        # a login for yourself
npm test                    # 131 tests; the database ones skip without DATABASE_URL
```

Secrets are shared out of band, not through the repo. `.env` is gitignored and
must stay that way: anything committed here is served publicly.

## Conventions

- Comments explain **why**, not what. The repo is full of decisions that look
  wrong until you know the reason; say the reason.
- Verify against production rather than asserting. Most of the bugs here passed
  a local check first.
- Test data is named `ZZ ...` so it can be found and removed afterwards.
  Always remove it.
- Never invent a price. The PMC blocks all pricing until Dina supplies the
  menu; AI scalp analysis at $40 is the single cleared figure.
- A booking's price is the one its stylist typed (since 2026-10-31,
  `ownPrice` in `timing.js`, through `timedService`): by kind, Highlights by
  their Highlights price, Color & Cut as Cuts plus Color only when both are
  typed, else the services table's (empty). Before, every booking was "Not
  priced" because it took only the table's. The team sees it on the
  appointment window and its total. Clients do not:
  `CLIENT_PRICES = false` in `config.js` keeps it out of every guest email
  and the manage page (the salon's choice, by the PMC), pinned by
  `tests/email-preview.test.js`. An appointment window still says "Booked
  before visits were itemized" with a dash on the line until migration 031
  (the `services` column) is approved and run on the live database; the
  total shows either way.

## Still outstanding

- ~~**Stylists are to set their own availability (salon's decision, 2026-10-15).**~~
  Done 2026-11-03, in My Settings (see Onboarding and who sees what), in
  the shape below: they edit their own, the owner sees and changes
  everyone's. Kept for the reasoning. Until then they could not: `hoursOpen()` in the console opens Working hours only to
  an admin editing somebody else, and `/api/staff/profile` throws away any
  hours sent from your own window (`const hours = null`). Both say in their
  comments that this is what the salon asked for, and both now say the
  opposite of what the salon wants, so read them with this note beside them.

  That rule was not arbitrary. Online booking was paused on 2026-09-30 because
  "the public calendar offered 9 AM with stylists who do not start then, and
  guests took it" (config.js): hours are not a personal preference here, they
  are what the website sells. The fix made one person own the rota.

  Whoever implements this should keep that failure in mind rather than simply
  deleting the check. The shape that keeps both: a stylist edits their own
  hours, and the admin still sees and can change everyone's, so a mistake is
  visible and correctable rather than silently sold. Changing only the console
  is not enough -- the server discards the values, which is deliberate, because
  hiding a control never stopped anyone posting to the API.

  Not scheduled. Doing it before the roster is filled would mix a new rule in
  with the first real bookings, which is how the 30 September problem started.


- **Settings, Salon, and Forgot Password?** (2026-11-06, asked for).
  - **Everyone reads the Salon Profile; only the owner and admins change
    it** (asked for the same day). The Salon tab is shown to every role;
    `GET /api/staff/business` answers anyone signed in (only `recipients`
    stays the owner's) with `canEdit: seesAll(user)`, and every save,
    logo included, is refused (403) for anyone else, managers too. A
    reader gets no pencil and no logo buttons, and a line saying who can
    change it. The "Where do you want people to reply to" card is on Karen
    AI now (below Email History), changed by the owner or an admin.
  - The Salon Profile no longer shows the Booking page (`bookingUrl` is
    still in the API). Labels sit level with the top of their box
    (`.biz-row.edit` is `align-items: start`): centred on the row, the
    Google review link's note had pushed its label below its box.
  - **Hours of Operation** (`tenants.hours`, 055, also in ensure-schema;
    `api/_lib/hours.js`): seven days, Sunday first, each `{open, close}` or
    null for closed, set by the owner in the Salon Profile's edit (each day
    Open with its times, or Closed). Never set, they are the hours the
    website had hard-coded (`DEFAULT_SALON_HOURS`). Shown on the Salon
    Profile (`hoursText`), at the foot of every email (`shopFrom().hoursLines`;
    `tenant.js` loads `hours` everywhere, the reminder cron too), to Karen
    (karen-ai's details and karen-desk's `salon_settings`), and on the
    website's "Open today": the pages' own clock reads `window.__ssHours`
    first, filled by `<script id="ss-hours">` in each page's static head
    from `/api/services` (`salon.hours`, written "9a to 3p"). These are
    opening hours for people to read; what is bookable is still each
    stylist's Available Hours. The JSON-LD opening hours in the pages are
    static and were not touched. `tests/salon-hours.integration.test.js`.
  - **Forgot Password?** under the password on the sign-in page opens a
    form for the email; `/api/staff/reset` (`reset.js`, through the staff
    router, no new function) answers the same words for any address and
    does the lookup and the email after answering (`waitUntil`), so neither
    the words nor the time tell who has an account. Only an active login
    gets a link: random, only its SHA-256 kept (`staff_users.reset_hash`,
    056, also in ensure-schema), one hour, spent on use, replaced by a newer
    request, requests two minutes apart. The link (`/reset?t=`, a vercel.json
    rewrite like `/invite`) opens `#reset`: the new password twice, then the
    sign-in form with the email filled; every session with the old password
    is deleted. The email (`sendPasswordReset`) is not an automation and is
    not kept in Email History, since it holds a working link.
    `tests/password-reset.integration.test.js`.

- **Clients has Filters and Sort** (2026-11-06, asked for), under the
  search: a Filters button opening a small panel (Status, Next visit: has a
  visit booked or not, Tag: only tags clients have, Card on file only; a
  count on the button, Clear filters) and a sort list (Recently added, Name
  A-Z and Z-A, Next visit soonest, Last visit most recent, Most visits,
  remembered per browser as `ss-client-sort`). Both are done by
  `/api/staff/contacts` (`next`, `card`, `tag`, `sort`, `CLIENT_SORTS`), so
  they cover every client and not just the first page; the page asks for up
  to 300. The list's next visit is now the soonest one ahead: it was `max()`,
  which showed a client with several visits booked their last as their next.
  `tests/clients-list.integration.test.js`.

- **`/documentation` is the public SynergyApp Documentation** (2026-11-06,
  asked for, laid out after portl.tax/documentation): one long page,
  `documentation.html`, on the Privacy Policy's own styles (header, Geist and
  Anton, the indigo, the footer), nine numbered sections with a contents
  list. Every label in it was read from the live app that day, signed in as
  the agency login with every write refused in the browser. It leaves out
  what is not usable yet (Payroll payouts, the subscription) and every price,
  and names no CRM. When a screen changes, change the page with it: it says
  "named as it appears in the app". In the sitemap.

- **The website's hero and header** (2026-11-06, asked for, in two rounds;
  all nine pages). The hero's glowing button is **Call Now** to the salon's
  own number (`tel:8136542055`, never Karen's), with 813.654.2055 under it:
  `.hero-bk` and `.hero-call`, in `.hero-ctas` on the home page and in every
  copy of `.sv-ctas` on the others (their `.hero-ctas` is in a hidden
  `.hero-foot`). It said BOOK ME NOW with Karen's number for a few hours.
  Later that day (asked for, to a reference) it reads **Call 813.654.2055**
  as a clear glass pill (the photo showing through; dark for an hour, then
  lightened on request) with a thin light edge and the periwinkle arrow
  circle, a soft glow breathing on its two sides (`a.btn.hero-bk`,
  `heroSideGlow`, still for reduced motion); the number line under it is
  hidden (`a.hero-call`), since the button says it.
  The header's button is **Book Now** (was Book Online), wrapped in
  `.nav-book` with an **Earliest Appointment** line (`.nav-soon`,
  `[data-ss-earliest]`): under the button on a computer; on a phone (where
  the button used to be hidden) the button is its own full-width row under
  the logo, about three times the computer one, the date under it, the hero
  words moved down and the hero made taller to match. The date is filled by
  `<script id="ss-earliest">` in each page's static head (a script in the
  bundle never runs): the first open Women's Cut from tomorrow, two weeks at
  a time up to six, cached ten minutes in sessionStorage; no time or no
  answer, and the line stays hidden. Left of the button (later that day,
  asked for in rounds) is **SOONEST OPENING**, plain text with a green dot
  (`.nav-open[data-ss-soon]`), and the time is the line under the button,
  "TOMORROW 9:00a with Dina" (`.nav-soon`; TODAY, TOMORROW, else "SAT, NOV
  8"; the stylist's first name from the slot's `stylists` in
  `/api/availability`), centred under the button (asked for), both shown or hidden together by `ss-earliest`. The
  label took the place of an OPEN NOW indicator (its `ss-open` script went
  with it) and shows only from 1440px wide, where it clears the menu's
  links; phones show the time centred under their full-width button. The button reads **Book Online** (was
  Book Now) and is 66px tall with 23px type from 768px up (asked for:
  twice the size, then a little back, then a little up again), 56px with
  18px type from 992 to 1199px where the menu's links share the bar;
  phones keep their own full-width row. A new
  export of any page undoes all of it: re-apply.

- **Online booking is live again (2026-11-06, asked for).** The
  `ss-booking-paused` block is gone from all nine pages and
  `ONLINE_BOOKING = true`, so every "Book" opens the real survey and the
  server takes online bookings (and Karen books clients by text, which
  follows the same flag). The only bookable stylist is Dina Lara
  (`dina-lara-2`: services on, Google connected), on the hours the app has
  for her, **Wednesday 10-5 and Thursday 10-7**, kept on request although
  Envision shows her working Thursday, Friday and Saturday. Envision still
  holds the salon's diary: Dina's Nov 12-20 and Dec 1-17 are copied in (see
  the memory note on the Envision import), and Thursdays not yet copied are
  blocked in `time_off` with the reason "Not yet copied from Envision"
  (Nov 26, Dec 24 and 31 all day; Dec 3 and 10 2:00-2:30; Dec 17
  2:00-3:30). Remove each block once that day is imported. Anything booked
  in Envision after the import is unknown here and can double-book.
  To pause again: `git show ae6b0ab` has the block as it was; put it back in
  the static head of every page that has a Book link (`grep -l
  ss-booking-paused` before this commit lists them) and set the flag false.
  `ONLINE_BOOKING` being a hardcoded constant still wants to become "this
  tenant has a bookable stylist".

- **Go-live checklist for online booking** (the code is done and tested
  against a local Postgres; nothing below is code):
  1. In Team, give each stylist their services and the admin sets their
     hours (Dina, Micah, Tami and Kim are there as stylists without a
     sign-in, keeping the slugs the website's links use). Anybody added
     after those four needs their Google Calendar connected to be offered
     online.
  2. ~~`RESEND_API_KEY` in Vercel~~ **done 2026-10-14**, together with
     `BOOKING_FROM_EMAIL=bookings@noreply.synergysalon.com` and the
     verified sending domain. Confirmations, reminders and the manage link
     all send.
  3. Dina confirms service durations.
  4. Remove the CENTRO booking widget (the leadconnectorhq iframe in the
     contact section of `index.html` and `hair-salon-riverview.html`): it is
     a second calendar the Synergy Calendar cannot see, so guests booking
     there would double-book. It is left in place only because it is the
     salon's live online booking until this goes live.
  5. Envision's appointments imported, or the first weeks double-book.
  6. Then lift the pause (below).
  Google sign-in (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_KEY`)
  is optional: it lets bookings be copied into stylists' Google Calendars.
- **Service durations need Dina.** Every one in `db/seed.sql` and
  `db/migrations/004` is an industry estimate, and they decide which slots get
  sold. A wrong one either wastes a chair or sells an appointment that cannot
  be finished.
- ~~**No `RESEND_API_KEY`**~~ Resolved 2026-10-14: the key is set, the
  domain is verified and guest email sends. Two things still owed on it --
  the key and the Google client secret both passed through a chat window
  and **want rotating**, and no template carries an unsubscribe link, so
  these may send transactional mail (a booking the guest asked for) but
  not marketing to a list.
- **Envision still holds the live diary.** The salon books there today. Nothing
  moves until its appointments and client list are exported and imported.
- FK Screamer is referenced but never published, so it 404s on every page and
  falls back to Anton. Harmless, still worth removing.
