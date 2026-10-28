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

The survey (same code in all six pages, Riverview included) is: 1 the kinds of service (Color,
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
`/thank-you` any more. Returning guests are filled in only from what this
browser saved at their last booking (`ss-guest` in `localStorage`, matched on
the typed name): looking a profile up by name on a public page would expose
any client's email and phone. Color's "Other" has no service, so it saves a
lead for the salon to call, as "Not sure yet" did.

**Phone polish for the popup** (2026-10-22) lives in the booking script of
all six pages' static heads, as a `<style id="ss-bk-polish">` put back into
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
The copies go into **a calendar of the salon's own in their Google account**,
named after the salon (asked for 2026-10-14): made on connect by
`salonCalendarFor` in `google.js` through the `calendar.app.created` scope,
which reaches only calendars the app made. Its id is
`staff_users.google_calendar_id`; `'primary'` there means "write to their
main calendar" (a connection from before the scope, or one that unticked it,
until they reconnect). Each copy records its calendar
(`google_events.calendar_id`, 020, also in ensure-schema) and is edited
there. Reconnecting the same account finds its calendar again; one the
stylist deleted is made again on the next booking. Busy time is read from the
main calendar only, never the salon one, and the main calendar's own copies
of bookings are skipped too: read back as busy, they stopped a guest moving
their own appointment. Add `calendar.app.created` to the OAuth consent
screen's scope list before submitting for Google's verification.
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
name to a slug through that, the old fixed map only as a fallback. The
popup always shows the four (`bkCore`, its original fixed list) and adds
anybody else the app returns; a stylist picked from a team card who is not
in the list is dropped when it arrives.

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
  (`homeHello()`), and the subtitle a word for the day ("Happy Friday!",
  "Enjoy your Saturday!", "Have a great morning today!") then the date
  (`greeting()`). No primary button. Two tiles from `GET /api/staff/home`
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
  "Past appointments (n)" underneath. The person chip (avatar and name) is
  on the right of the nav; it was hidden for a day and brought back on
  request. `.main` starts 116px down (108 and 100 on
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
- Nav: Home, Appt. Book, Clients, Settings (addresses above; Marketing is a Settings tab since 2026-10-24). Clients has "Choose your stylist"
  (2026-10-22): All, then every stylist record from `contacts?stylists=1`
  (`stylistChoices`), with or without a login, calendar or payroll, so long
  as they are active or have ever been booked; one who has left stays,
  marked "left", so their clients can still be found (`?stylist=<slug>`).
  Each client's tag is their stylist, whoever they last booked with
  (`STYLIST_OF`), not their source; the source tags ("Front desk") are gone
  from the list and the profile chips, and the source is still on the
  profile. The lead-stage filters were removed on request; each row still
  shows its stage. The stylist row stays on one line (scrolls sideways).
- Tickets (2026-10-22): the appointment is the diary's reservation, the
  ticket the visit. `GET /api/staff/appointment?ref=` (`ticketFor`) is the
  one source for both the Appt. Book card and a client's history (their
  appointment rows and every timeline event with a ref open it): client,
  stylist, when, each service with its time and price, the total, payment.
  Lines come from `appointments.services` (migration 031), written at
  booking from `combineServices().lines`; a visit booked before that shows
  its first service and the total, marked not itemized, never a guessed
  split. Payment is "Not recorded" and there are no transactions: nothing
  records payments until Stripe. Check in, no-show, cancel, done, reopen
  and delete stay on it. There is no staff reschedule action anywhere yet.
- The client profile edits in place: a pencil on Contact details (name,
  phone, email) and on Tags and status (the stage), Add note (a dated line
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
  toast lifted above it. On wider screens it stays in the page head.
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
  Karen's picture is a friendly assistant's face drawn as an inline SVG
  (`KAREN_PIC`), not a stylist's avatar, on request.
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
  page says "No number connected yet".
- Clients, Activity: each kind of event has its own colour (asked for
  2026-10-22): booked green, emails (and texts, when there are any) yellow,
  checked in blue, done teal, no-show orange, cancelled red, the website
  form pink, added grey. Contact details no longer repeats the phone, which
  is at the top of the profile; it is still edited with the pencil there.
- Payroll (2026-10-22): processed every Friday, staff and stylists paid by
  the end of that day. The Payroll card says so, with the next payday on
  the salon's clock (`paintPayday`); nothing is paid from the app yet.
- Card on file (2026-10-22): a green "Card on file" chip under the client's
  name in Clients and on their profile, for the salon's preferred clients
  (a no-show can be charged the fee; a visit is paid through the stylist).
  It is a flag the team sets with the Payment switch on the profile
  (`contacts.card_on_file`, migration 032, also in ensure-schema since it is
  additive and defaults to no; `PATCH {op: 'card'}`, `setCard`). Nothing in
  the app takes or stores a card; when Stripe lands it can set the flag.
- Migration 031 is NOT in ensure-schema, on purpose: previews share the
  live database, and ensure-schema would run it there unasked. Until it is
  run (alone, after approval) everything reads the columns through to_jsonb
  and `hasColumn` (db.js) guards the writes: bookings are as before, tickets
  are not itemized, and the preference switches show as not available yet.
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
  for everyone: a Salon tab (Where do you want people to reply to, then Salon Profile; key `salon`, where Settings opens) and a Team tab (Team Members, Appearance, Sign out; key `team`, where the person chip and `/account` open), split on request on 2026-10-23 after a week as one "Salon & Team" page, and Payroll for owners, admins and managers (a "Coming soon"
  card, added 2026-10-16). Billing, also "Coming soon" and for the same people, is a card on Salon
  under the reply-to address since 2026-10-26, no longer a tab of its own. It has no Calendars tab:
  calendars are made from Appt. Book's "Create a calendar" note (shown only
  while there are none) or `/staff/calendars`, without choosing members for now
  (stylists are not on the app yet; calendar settings saves members back
  unchanged and no longer shows a picker), and the New calendar form offers the
  calendar apps (Google by sign-in, and any other app by subscribing
  to the person's private feed, links from `GET /api/staff/calendars`), Outlook is left out of the form on request (`calAppRows()`). The person chip
  and `/staff/account` open Settings on Team. The calendar settings page has a Back button to Appt. Book, on the Day or Month view last open (`ss-cal-view` in `localStorage`). Sign out is in your own
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
  The phone is edited there in place with its own pencil, like the name, and
  Personal information no longer has a Phone field (Email and Role only). The username is
  no longer shown there: its row is hidden but stays in the form, so saving
  keeps it, and the Clients filters still label people by it. Connect your
  tools has a Stripe card under Google's reading "Coming Soon"
  (`.gcard.soon`, nothing to press). Services & pricing has Price and
  Duration (minutes, 5 to 720) on each service, and inside each service's
  card, directly under its description, a "Notes / Special Instructions for
  Clients" field. Since 2026-10-17 (on request) that is **one shared box
  under all the services** (the last card), always shown, instead of one
  per card; notes saved per service are carried into it, labelled. Color
  has no single Duration: it has Start, Break (processing) and Finish, once
  for Color and once for Highlights, with the total beside each. All of it
  lives in the same `services` object (`{cuts: {on, price, duration},
  color: {on, price, duration, start, break, finish, highlights: {...}},
  ..., notes}`, cleaned by `servicesFrom` in `profile.js`):
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
  live by `busyBetween` in `google.js` (times only, the fields mask never asks
  Google for titles), their own salon bookings and blocks, and the salon-wide
  ones. Clicking an empty time books with them. Google busy time blocks
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
  Connected means connected either way (`googleStatus`), everywhere: the
  tools card, the New calendar form's Google row (`calAppRows`, which used to
  read only the sign-in and offered Google again to anyone connected by the
  address) and the calendar dialog. `GET /api/staff/profile` carries the
  status, so your own window opens right instead of offering Connect until a
  second request answered; it says "Checking…" if the status is missing.
- Appt. Book's day is the team, one column per person: the shared
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
  `?demo` on the address shows a sample day that saves nothing.
- Marketing is a **Settings tab** since 2026-10-24 (it was an item in the
  top menu): `set-marketing`, after Team. Its own two tabs, **Automations**
  and **Email History** (so spelled on request, 2026-10-24), keep their
  addresses (`/marketing/automation`, `/marketing/history`; `group:
  'settings'`, `view: 'settings'`), which open Settings on that tab; the
  gear opens Salon, not Marketing. Email History is its
  own module now, with a search by name or address and a filter by message
  (`?history=1&q=&kind=`), each row opening that email (`?sent=<id>`,
  `sentMessage`). The log keeps who, which message and when, not a copy, so
  the email is rendered again from the booking as it is now and the window
  says so; the manage link carries a dummy token, never the guest's; a
  booking deleted since shows sample details. **Finance** moved to Home on
  2026-10-24 (`#homeFin`, under the widgets; `/marketing/finance` now lands
  on Home), owners, admins and managers only (the card stays hidden for
  anyone else, and a 403 from `?finance=1&from=&to=`): what visits were
  worth in a period, total and by stylist -- earned so far, average visit,
  booked ahead -- counted as Home counts value (kept = not cancelled and not
  a no-show; the booked price, else the service's; unpriced visits named, not
  guessed). The app records no payments yet, and Finance says so on the
  page. The old `/marketing/email` address opens Email History.
- **Booking references are not shown** (asked for 2026-10-24), except in a
  client's contact details (the timeline's "Ref" on each booking event): not
  in Email History or its email window, the appointment window, Karen's
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
- Settings, Salon Profile is the tenant's details. Its logo is the nav's mark,
  painted from `me.salon.logo`, so saving updates the menu at once.
- Team lists only the signed-in person for now (stylists are added later),
  plus anyone asking to join. Each person has a username (011) and their own
  services and prices, `staff_users.services` (012): Cuts, Treatments, Color,
  Styling, each on or off with a price they typed (dollars and cents, the
  field steps by 0.01; it used to step by 1 and the browser refused to save
  45.50). Never a computed price.
  Reads use `to_jsonb` so the console loads before 011 and 012 run; saving
  those fields needs them.
- Faces are pictures, real ones first: an uploaded photo, then the stylist's
  portrait (`api/_lib/stylist-photos.js`, also copied to `stylists.photo` by
  012), then an avatar the person chose, then a default avatar. Avatars are
  Microsoft's Fluent 3D emoji people (MIT, `assets/avatars/`), the style the
  team picked; the stylists are all women, so the default is always a woman,
  and men are only there to be chosen. A chosen avatar is stored in
  `staff_users.avatar` as its `/assets/avatars/...` path.
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
  without a sign in reads as not connected. Everybody can read the
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
  Replies go to `shopFrom().replyTo` (`hair@synergysalon.com`), which is a
  different address on purpose and not a Resend domain.
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

## Still outstanding

- **The Brandon and FishHawk pages are on hold until about 2026-10-20**
  (salon's instruction, 2026-10-16). Do not create, publish or link
  `hair-salon-brandon.html` or `hair-salon-fishhawk.html` before that date,
  and do not treat the Riverview page as a template to fan out from yet.

  Both towns are already served on the site and that stays as it is: they are
  in the `areaServed` city list in every page's schema, in the home page's
  "Valrico, Brandon, Lithia and FishHawk" lede, and in the hero line "Serving
  Valrico, Brandon, Lithia, and FishHawk since 2004." The hold is on the two
  dedicated geo landing pages, nothing else. Taking the towns out of the copy
  or the schema would be the opposite of what was asked.

- **Stylists are to set their own availability (salon's decision, 2026-10-15).**
  Today they cannot: `hoursOpen()` in the console opens Working hours only to
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


- **Online booking is paused, and the reason has changed.** It is no longer
  about hours: those are owned and editable now. It is that the salon has no
  bookable stylist. All four `stylists` rows are deactivated and tied to no
  login, and neither RJ nor Luis has a service switched on, so `loadStylists`
  raises a 404 for every service. Add somebody through Team with services and
  hours first; unpausing before that shows guests an error.
  Every "Book" link currently opens an "Online appointments are coming soon,
  please call" notice, and `ONLINE_BOOKING = false` in `api/_lib/config.js`
  makes the server refuse online bookings too (leads are still saved as
  contacts; staff bookings are unaffected). The full booking popup is still in
  every page, untouched, behind the notice, and commit `ae6b0ab` on main
  is the site exactly as it was before the pause.
  To restore: delete the block between `ss-booking-paused:start` and
  `ss-booking-paused:end` in the static head of **all six** pages --
  `index.html`, the four service pages, **and `hair-salon-riverview.html`**
  -- and set `ONLINE_BOOKING` back to `true`. This said "the four service
  pages" until 2026-10-15, which is five files; Riverview was added after the
  pause was written and carries the block too. Following the old list would
  have left the geo landing page, the one with thirteen Book CTAs on it,
  still saying "coming soon" after booking went live everywhere else.
  Check with `grep -l ss-booking-paused *.html` rather than trusting a count. Do it only once at
  least one person is bookable and their hours are right.
  `ONLINE_BOOKING` being a hardcoded constant does not belong in a product
  sold to more than one salon; it wants to become "this tenant has a bookable
  stylist".

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
