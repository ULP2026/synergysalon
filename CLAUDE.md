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

Postgres owns the diary. CENTRO (GoHighLevel) is a mirror, never the source.
If anyone books in CENTRO's own calendar as well, only half the appointments
are protected and double-booking returns.

**Double-booking is prevented by the database, not by code:**

```sql
EXCLUDE USING gist (stylist_id WITH =, during WITH &&)
WHERE (status <> 'cancelled')
```

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
phone and optional notes with "Book Me Now!" (stylist moved to step 2 on
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

**Demo mode for preview links.** `?booking-demo=1` on a `*.vercel.app` (or
local) address opens the real popup despite the pause, shows a yellow
"nothing is saved" bar, and answers "Book Me Now!" with a made-up booking
without posting anything. It exists because preview deployments have their
own `DATABASE_URL` that points at the live data, so a real test booking there
is a real appointment. The flag is ignored on the salon's own domain.
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

**Every push to CENTRO sends the appointment as it stands now**, not the event
the job describes: jobs run late and out of order after a failure, and an old
"booked" must not undo a newer "cancelled". Check-in, done and no-show are
mirrored as CENTRO's showed/noshow. Settings has no Integrations card any
more (removed on request): nothing in the console shows the CRM link, and the
refused list and its retry button were taken out before that. The cron still re-queues refused jobs from the last
30 days whenever the link checks out, and logs why each failed, and
`POST /api/staff/centro {action:"retry"}` still exists.

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
run after every `drain()` and so by the daily cron; a pasted address is
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
CENTRO still gets a copy of every booking, move and cancellation through
`sync_outbox`, unchanged; the guest's own reschedule and cancel now drain
the queue at once (`api/appointment.js`) instead of waiting for the cron.

**Several services are one appointment.** The survey's other services go to
the server (`body.services` on `/api/enquiry`, `&with=` on
`/api/availability`) and are booked as one appointment with one stylist who
offers every one: the guest's time is all of them end to end with the
clean-downs between, the last clean-down after (`combineServices`), priced
only when every part has a price. Moving it keeps its own length (`length`
on `availableSlots`).

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

- Home (`/staff`) is a grid of widgets the admin arranges: Customize (top
  right, only for `canManageTeam`, the same "admin" as team management)
  turns each card into an editor (move earlier or later, Bars/Line/Table
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
- Nav: Home (`/staff`), Appt. Book (`/staff/appointments`), Clients
  (`/staff/clients`), Marketing, Settings. Clients filters by stylist (All,
  then a button per team member with the Stylist role, matched through the
  stylist row linked to their login, `?member=`) and by source tag. The
  lead-stage filters (All, New, Contacted, Booked, Client, Lost) were removed
  on request; each row still shows its stage. The stylist row stays on one line (scrolls sideways),
  labels each person by username, else a name shortened past 12 characters,
  and gives each a colour fixed by their id. While nobody has the Stylist
  role the whole team stands in as placeholder filters. It refetches the team
  on opening Clients, after the team list loads, and when the tab regains
  focus, so a new stylist appears without a reload.
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
  for everyone: one Salon & Team tab (Appearance, Where do you want people to reply to, Team Members, then Salon Profile, merged into one page on request on 2026-10-15; the tab key is still `team`), and Billing for owners and managers. It has no Calendars tab:
  calendars are made from Appt. Book's "Create a calendar" note (shown only
  while there are none) or `/staff/calendars`, without choosing members for now
  (stylists are not on the app yet; calendar settings saves members back
  unchanged and no longer shows a picker), and the New calendar form offers the
  calendar apps (Google by sign-in, and any other app by subscribing
  to the person's private feed, links from `GET /api/staff/calendars`), Outlook is left out of the form on request (`calAppRows()`). The person chip
  and `/staff/account` open Settings on Salon & Team. The calendar settings page has a Back button to Appt. Book, on the Day or Month view last open (`ss-cal-view` in `localStorage`). Sign out is in your own
  profile window. `/staff/dashboard` and `/staff/contacts` still land on Home and
  Clients. The UI says "CRM"; the API keeps its `centro`
  names, which nobody sees.
- **The team member window** asks for each fact once. The header is the
  person: their picture (the circle, or Change picture, opens its own small
  window: Upload a photo or Choose an avatar), their name as the heading,
  edited in place (it is the Name field), and @username under it, each
  with a pencil that puts the cursor in the field (hidden where it cannot be
  edited). Then
  Personal information (Email, Phone, Role; phone is `staff_users.phone`,
  007, now read and written by `team.js` as well as `profile.js`), Connect
  your tools, Services & pricing, Working hours. A stylist without a sign-in shows only
  services and hours (name and picture read-only). Working hours are set
  by the admin only (`hoursOpen()`: the admin on somebody else's window or
  adding somebody); a stylist sees their own grey and disabled, and
  `/profile` ignores hours sent to it, so the stored ones are kept; the steps card
  that used to say what opens it was removed on request. The admin
  (`canManageTeam`, the app's one admin rule: role owner or a
  `TEAM_ADMIN_EMAILS` login; managers are not admins; Luis Lara is the
  admin, so his account needs the Owner role) gets neither Services & pricing nor Working hours (`#memberWork`
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
  the same modal, then an "Add a team member" row. Everybody can read the
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
  from `team.js`, commit `7cb18b4`). The sender is `BOOKING_FROM_EMAIL`
  and it **must** be on the domain verified in Resend: the salon verified
  `noreply.synergysalon.com` while the code still defaulted to the root
  domain, and every send failed with a 403 that never reached the console.
  The welcome (and any team email) comes from `noreply@` on that same domain
  (`TEAM_SENDER` in `email.js`, `TEAM_FROM_EMAIL` overrides), not
  `bookings@`, asked for 2026-10-15: it is not a booking.
  Replies go to `shopFrom().replyTo` (`hair@synergysalon.com`), which is a
  different address on purpose and not a Resend domain.
  Removing somebody deletes them (`action:"delete"` on `/api/staff/team`,
  "Remove from team" in their window), asked for in place of turning the
  account off. Their `stylists` row is switched off first, not deleted:
  appointments keep their name, and a stylist with no login would otherwise
  count as bookable. Sessions and calendar tokens go with the login; booked-by
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

## Local setup

```bash
npm install
cp .env.example .env        # then fill it in; never commit it
npm run db:setup            # schema + seed
npm run db:migrate          # anything newer
npm run ghl:link            # verify and store the CENTRO credentials
npm run staff:create        # a login for yourself
npm test                    # 95 tests; the database ones skip without DATABASE_URL
```

Secrets are shared out of band, not through the repo. `.env` is gitignored and
must stay that way: anything committed here is served publicly.

## Conventions

- Comments explain **why**, not what. The repo is full of decisions that look
  wrong until you know the reason; say the reason.
- Verify against production rather than asserting. Most of the bugs here passed
  a local check first.
- Test data is named `ZZ ...` so it can be found and removed from both this
  database and CENTRO afterwards. Always remove it.
- Never invent a price. The PMC blocks all pricing until Dina supplies the
  menu; AI scalp analysis at $40 is the single cleared figure.

## Still outstanding

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
