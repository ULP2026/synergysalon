# Synergy Salon — working notes

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

## The pages are design-tool exports

`index.html` and the four service pages are single-file bundles from a design
tool. A bundle holds:

- `<script type="__bundler/manifest">` — base64 assets, some gzipped
- `<script type="__bundler/template">` — the whole page as a JSON string
- a loader that mints blob URLs and calls `documentElement.replaceWith()`

Two consequences that have each cost a day:

**A script inside the template never executes.** The parser only runs scripts
it parsed itself, and `replaceWith()` does not count. Anything that must run —
tracking, the booking adapter — goes in the *static* `<head>`, binds to
`document` or `window` (both survive the replacement), and delegates its
handlers. This is not obvious locally, where it can appear to work.

**Every export drops what is not in the design source.** GA4, canonical,
description, Open Graph, favicons, real reviews, and every link fix. When a new
export arrives, re-apply them. There are scripts for this pattern in the
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

Checking availability before inserting cannot work on its own — two requests
both read "free" before either writes. `tests/booking.integration.test.js`
proves the constraint by running the race.

The homepage wizard is a design-tool component with **no backend of its own**.
As shipped it collected seven steps and discarded them, and its calendar was
invented: a hash of the date and stylist name kept 42% of slots. The adapter in
the static head reads the rendered DOM, posts to `/api/enquiry`, and replaces
the fake availability with the real diary.

`/api/enquiry` saves the contact *before* attempting the appointment, and books
whenever it has a service and a time rather than waiting for the wizard to say
it finished — that signal failed four separate ways. Because it is called on
every keystroke, it also refuses to create a second appointment for a guest who
already has one.

**Identity comes from the session id, not from the email box.** The wizard
mints an id when it opens and sends it with every call; the server resolves the
contact from that first and falls back to email or phone. Keying on the email
alone meant every prefix of an address looked like a new person — one guest
booking once produced five contacts and four appointments — and every prefix
was then rejected by CENTRO with a permanent 422, which killed the appointment
push attached to it. A detail is only stored or sent once it is whole: a
half-typed address is not a worse email, it is not an email yet.

**Every push to CENTRO sends the appointment as it stands now**, not the event
the job describes: jobs run late and out of order after a failure, and an old
"booked" must not undo a newer "cancelled". Check-in, done and no-show are
mirrored as CENTRO's showed/noshow. Team Settings, Integrations shows only
whether the CRM is connected; the refused list and its retry button were taken
out of the UI on request. The cron still re-queues refused jobs from the last
30 days whenever the link checks out, and logs why each failed, and
`POST /api/staff/centro {action:"retry"}` still exists.

**Stylists' hours come from CENTRO, for guests.** Online availability offers a
stylist only the times CENTRO's free-slots answer lists for their CENTRO user:
the hours set for them on the calendar, what is already booked there, and the
calendars they connected in CENTRO (`api/_lib/centro-hours.js`). A stylist not
linked to a CENTRO user is offered nothing online, and a
CENTRO error offers nothing rather than guess. Staff booking in the console
still uses `stylist_hours`, on purpose. The seeded `stylist_hours` gave every
stylist the salon's opening times, which is how 9 AM got sold with stylists
who start later.

The screen for linking stylists to CENTRO users was removed from the console
on request. Linking now goes through `POST /api/staff/centro
{action:"link", stylist, ghlUserId}` (or SQL on `stylists.ghl_user_id`); put a
screen back before reopening online booking, or nobody is offered online.

**Testing while online booking is paused.** The console button was removed on
request; `POST /api/staff/centro {action:"preview"}` still mints a signed 12-hour pass (`api/_lib/preview.js`) and opens the public
site with `?booking-preview=`. The notice script keeps it for that tab, shows
the real popup with a "test mode" badge, and adds `x-booking-preview` to its
`/api/` calls, which the server accepts in place of `ONLINE_BOOKING`. Bookings
made that way are real: name them ZZ and remove them.

## Staff console

- Nav: Home (`/staff`), Appointments, Clients (`/staff/clients`), Marketing,
  Settings (Salon Profile, Calendars, Billing). The person chip opens Team
  Settings (`/staff/account`): Appearance, Integrations (one row per
  connection: CRM for owners and managers, Email, Google, Apple, Outlook) and
  Team Members. Sign out is in your own profile window. `/staff/dashboard` and `/staff/contacts` still land on Home and
  Clients. The UI says "CRM" and "Integrations"; the API keeps its `centro`
  names, which nobody sees.
- Appointments opens on the day: one column per stylist, the clock down the
  side. LUNCH and BLOCK are rows in `time_off`, the table availability already
  subtracts, so a block on the grid really stops the time being sold.
  `?demo` on the address shows a sample day that saves nothing.
- Settings, Salon Profile is the tenant's details. Its logo is the nav's mark,
  painted from `me.salon.logo`, so saving updates the menu at once.
- Team lists only the signed-in person for now (stylists are added later),
  plus anyone asking to join. Each person has a username (011) and their own
  services and prices, `staff_users.services` (012): Cuts, Treatments, Color,
  Styling, each on or off with a price they typed. Never a computed price.
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
- Appointments shows a Calendars bar with only the calendars in use (the
  Salon Calendar); stylist calendars join it once they can be connected
  (`calendarList()`), and live in the Create or connect dialog until then.
- Team Members lists you, then (owners and managers) everyone else on the
  team, each card opening the same modal, then an "Add a team member" row.
- Appearance is per browser (`localStorage` `ss-theme`), applied in the head
  before first paint.

## Gotchas worth knowing before you hit them

**Untyped query parameters.** `tstzrange($1, $1 + make_interval(mins => $2))`
fails with `42P08` or `42883`: Postgres cannot deduce the type. Cast every
parameter inside a function call — `$1::timestamptz`, `$2::int`. This has bitten
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
IPv6 only and Vercel cannot reach it — works from a laptop, fails in production.

## Local setup

```bash
npm install
cp .env.example .env        # then fill it in; never commit it
npm run db:setup            # schema + seed
npm run db:migrate          # anything newer
npm run ghl:link            # verify and store the CENTRO credentials
npm run staff:create        # a login for yourself
npm test                    # 61 tests; the database ones skip without DATABASE_URL
```

Secrets are shared out of band, not through the repo. `.env` is gitignored and
must stay that way — anything committed here is served publicly.

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

- **Online booking is paused.** Stylists have not set their individual hours
  yet, and the public calendar sold 9 AM slots with stylists who do not start
  then. Every "Book" link now opens an "Online appointments are coming soon,
  please call" notice, and `ONLINE_BOOKING = false` in `api/_lib/config.js`
  makes the server refuse online bookings too (leads are still saved as
  contacts; staff bookings are unaffected). The full booking popup is still in
  every page, untouched, behind the notice, and commit `ae6b0ab` on main
  is the site exactly as it was before the pause.
  To restore: delete the block between `ss-booking-paused:start` and
  `ss-booking-paused:end` in the static head of `index.html` and the four
  service pages, and set `ONLINE_BOOKING` back to `true`. Do it only once
  availability respects each stylist's hours.

- **Service durations need Dina.** Every one in `db/seed.sql` and
  `db/migrations/004` is an industry estimate, and they decide which slots get
  sold. A wrong one either wastes a chair or sells an appointment that cannot
  be finished.
- **No `RESEND_API_KEY`**, so confirmation emails are skipped silently. The
  booking is real; the guest is not told in writing.
- **Envision still holds the live diary.** The salon books there today. Nothing
  moves until its appointments and client list are exported and imported.
- FK Screamer is referenced but never published, so it 404s on every page and
  falls back to Anton. Harmless, still worth removing.
