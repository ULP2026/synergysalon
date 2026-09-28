# Booking system

Replaces the embedded GoHighLevel calendar with one the salon owns end to end.

```
browser  →  /api/…  (Vercel Functions)  →  Postgres
                          └→ Resend (confirmation, reschedule, cancel, reminder)
```

The rest of synergysalon.com is still static HTML and is unaffected.

## How double-booking is prevented

Not by checking availability before inserting. That check cannot work on its
own, because two requests can both read "free" before either one writes.

It is prevented by this, in `schema.sql`:

```sql
ALTER TABLE appointments
  ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (stylist_id WITH =, during WITH &&)
  WHERE (status = 'booked');
```

Postgres refuses to store two live appointments whose time ranges overlap for
the same stylist. The loser of a race gets an error, which `book.js` turns
into a 409 and, when the guest asked for "first available", retries against
the next free stylist. `tests/booking.integration.test.js` proves it by
running the race for real.

## Setting it up

**1. Point it at Postgres.** Supabase is Postgres, so nothing here changes —
but take the connection string from **Project Settings → Database → Connection
string → Transaction pooler**, not the one labelled "direct connection".

Two reasons, both of which cost an afternoon to discover:

- Supabase's direct connection is **IPv6 only**, and Vercel's functions do not
  reach it. The pooler is reachable over IPv4.
- Functions start and stop constantly. Without a pooler, a busy morning opens
  more connections than the database will allow.

The pooler string uses port **6543** and looks like:

```
postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

Transaction-mode pooling supports everything this code does, including the
savepoints `book.js` relies on.

**2. Set the environment variables** on the Vercel project:

| Variable | Needed | What it is |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `RESEND_API_KEY` | yes | [resend.com](https://resend.com) API key. Without it, bookings still work and emails are skipped with a warning |
| `BOOKING_FROM_EMAIL` | no | Defaults to `Synergy Salon <hair@synergysalon.com>`. The domain must be verified in Resend |
| `SITE_URL` | no | Defaults to `https://synergysalon.com` |
| `CRON_SECRET` | no | If set, the reminder endpoint requires it. Vercel sends it automatically |

**3. Create the tables.** Either paste `schema.sql` then `seed.sql` into the
Supabase SQL editor, or put the connection string in a local `.env` (which is
gitignored) and run:

```bash
echo "DATABASE_URL=postgres://…" > .env
npm run db:setup
```

Idempotent — it skips the seed if services already exist. `--reset` drops
everything first and asks for confirmation when the database is not local.

**4. Check it:**

```bash
npm test
```

With no `.env` this runs the slot arithmetic only and skips the rest. With a
`DATABASE_URL` it also runs the double-booking tests against the real
database, which is the only way that guarantee is actually proven.

### A note on Supabase's other half

These tables are reached only by the API functions, over the Postgres
connection, using credentials that are not in the browser. They are not
exposed through Supabase's REST API and no anon key touches them. If anyone
later turns on the REST API for these tables, enable row level security first
— an unprotected `appointments` table is every guest's name, email and phone
number.

## Before this can go live

**Service durations are placeholders.** `seed.sql` uses industry-standard
times. They drive availability directly, so a wrong number sells a slot the
salon cannot honour. Every one needs confirming against how long the work
actually takes at Synergy.

**Prices are deliberately absent.** `price_cents` is NULL for everything
except AI scalp analysis at $40, which is the only figure the PMC clears. The
front end says "priced at consultation" rather than inventing one. Fill them
in once Dina supplies the menu.

**Stylist hours are the salon's hours.** All four stylists are seeded with the
full opening hours and offering every service. Narrow both as soon as the real
rotas exist, or "first available" will offer a stylist who is not in that day.

## API

| | |
|---|---|
| `GET /api/services` | the menu, and who offers what |
| `GET /api/availability?service=&stylist=&from=&to=` | free slots; omit `stylist` for first available |
| `POST /api/book` | `{service, stylist, start, name, email, phone, notes}` → `{ref, manageToken}` |
| `GET /api/appointment?ref=&t=` | look up a booking |
| `PATCH /api/appointment?ref=&t=` | reschedule |
| `DELETE /api/appointment?ref=&t=` | cancel |
| `GET /api/cron/reminders` | day-before reminders, run daily by Vercel Cron |

Guests have no accounts. The token in the confirmation email is the
credential: random, single purpose, and compared in constant time so an
unknown reference and a wrong token are indistinguishable.

## Changing the rules

Everything a person would reasonably want to adjust is in
`api/_lib/config.js`: the salon timezone, the slot grid, minimum lead time,
how far ahead the diary opens, and the reminder window.
