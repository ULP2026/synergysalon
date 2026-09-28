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

**1. Create a Postgres database.** Vercel → Storage → Postgres (Neon) is the
path of least resistance: it sets `DATABASE_URL` on the project for you. Any
Postgres 14+ works.

**2. Set the environment variables** on the Vercel project:

| Variable | Needed | What it is |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `RESEND_API_KEY` | yes | [resend.com](https://resend.com) API key. Without it, bookings still work and emails are skipped with a warning |
| `BOOKING_FROM_EMAIL` | no | Defaults to `Synergy Salon <hair@synergysalon.com>`. The domain must be verified in Resend |
| `SITE_URL` | no | Defaults to `https://synergysalon.com` |
| `CRON_SECRET` | no | If set, the reminder endpoint requires it. Vercel sends it automatically |

**3. Create the tables:**

```bash
DATABASE_URL='postgres://…' npm run db:setup
```

Idempotent — it skips the seed if services already exist. `--reset` drops
everything first and asks for confirmation when the database is not local.

**4. Check it:**

```bash
npm test                                   # slot arithmetic, no database needed
DATABASE_URL='postgres://…' npm test       # also the double-booking guarantee
```

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
