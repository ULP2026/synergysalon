/**
 * GET /api/staff/diary?date=YYYY-MM-DD: one day's book, by stylist.
 * GET /api/staff/diary?month=YYYY-MM   : the same rows for a whole month.
 * POST   /api/staff/diary                : put a LUNCH or BLOCK on a stylist.
 * DELETE /api/staff/diary                : take one off again.
 *
 * Lunch and blocks are rows in time_off, the table availability already
 * subtracts, so a block on the day view is the same thing that stops the
 * time being sold. A separate "display only" block would be a picture of a
 * break that the booking form ignores.
 *
 * One query serves both because the month view is the day view zoomed out:
 * the same appointments, grouped by date. A second endpoint would be a second
 * place for the two to disagree about what "cancelled" looks like.
 *
 * The day also carries a column per team member who has connected Google
 * Calendar: their busy times that day, read live from Google (google.js says
 * why only the times). Live rather than synced, because a copy would be
 * wrong the moment they moved something in Google, and a day is one request.
 *
 * Scoped to the signed-in user's salon, never to a tenant named in the query
 * string. Cancelled appointments are included but marked, because the front
 * desk needs to see that the 2pm was cancelled rather than wonder where it
 * went.
 */
import { waitUntil } from '@vercel/functions';
import { DateTime } from 'luxon';

import { assertSameOrigin, canManageTeam, requireStaff } from '../../_lib/auth.js';
import { query } from '../../_lib/db.js';
import {
  busyBetween, dropBlock, googleConfigured, pushBlock,
} from '../../_lib/google.js';
import { icsBusyBetween, openLink } from '../../_lib/google-ics.js';
import {
  HttpError, handler, json, readJson, requireDate, requireString,
} from '../../_lib/http.js';
import { tenantForUser } from '../../_lib/tenant.js';
import { cleanBreaks } from '../../_lib/timing.js';

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);

    const url = new URL(req.url, 'http://localhost');
    const date = url.searchParams.get('date')
      ? requireDate(url.searchParams.get('date'), 'Date')
      : DateTime.now().setZone(tenant.timezone).toISODate();

    // A month is asked for as YYYY-MM. Anything else is treated as a day, so
    // an unparseable month cannot quietly widen the query to a whole year.
    const monthParam = url.searchParams.get('month');
    const month = /^\d{4}-\d{2}$/.test(monthParam || '')
      ? DateTime.fromISO(`${monthParam}-01`, { zone: tenant.timezone })
      : null;
    if (monthParam && (!month || !month.isValid)) {
      throw new HttpError(400, 'Month must look like 2026-09.');
    }

    const day = DateTime.fromISO(date, { zone: tenant.timezone });
    const from = month ? month.startOf('month') : day.startOf('day');
    const to = month ? month.endOf('month') : day.endOf('day');

    const { rows } = await query(
      `SELECT a.ref, a.starts_at, a.duration_min, a.status, to_jsonb(a) -> 'breaks' AS breaks, a.channel, a.checked_in_at,
              a.guest_name, a.guest_email, a.guest_phone, a.notes,
              a.price_cents, a.created_at,
              -- The guest's next visit after this one, for the day card.
              (SELECT min(n.starts_at) FROM appointments n
                WHERE n.contact_id = a.contact_id AND n.status = 'booked'
                  AND n.starts_at > a.starts_at) AS next_starts_at,
              s.slug AS stylist_slug, s.name AS stylist_name,
              v.name AS service_name,
              b.name AS booked_by_name,
              ct.id AS contact_id
         FROM appointments a
         JOIN stylists s ON s.id = a.stylist_id
         JOIN services v ON v.id = a.service_id
         LEFT JOIN staff_users b ON b.id = a.booked_by
         LEFT JOIN contacts ct ON ct.id = a.contact_id
        WHERE a.tenant_id = $1 AND a.starts_at >= $2 AND a.starts_at <= $3
        ORDER BY a.starts_at, s.sort_order`,
      [tenant.id, from.toISO(), to.toISO()],
    );

    const appointments = rows.map((r) => {
      const starts = DateTime.fromJSDate(new Date(r.starts_at)).setZone(tenant.timezone);
      return {
        ref: r.ref,
        startsAt: r.starts_at,
        // The date on the salon's clock, so the month grid puts a late
        // appointment in the right cell regardless of the viewer's timezone.
        date: starts.toISODate(),
        time: starts.toFormat('h:mm a'),
        endTime: starts.plus({ minutes: r.duration_min }).toFormat('h:mm a'),
        durationMin: r.duration_min,
        // Processing breaks, [minutes from the start, minutes long]: the
        // stylist is free in them, so the day draws them open and bookable.
        breaks: cleanBreaks(r.breaks, r.duration_min),
        status: r.status,
        channel: r.channel,
        checkedInAt: r.checked_in_at,
        service: r.service_name,
        stylist: r.stylist_name,
        stylistSlug: r.stylist_slug,
        guestName: r.guest_name,
        guestEmail: r.guest_email,
        guestPhone: r.guest_phone,
        notes: r.notes,
        price: r.price_cents == null ? null : r.price_cents / 100,
        bookedBy: r.booked_by_name,
        contactId: r.contact_id,
        createdAt: r.created_at,
        nextStartsAt: r.next_starts_at,
      };
    });

    // Lunch and blocks, for the day view only: the month grid shows bookings.
    let blocks = [];
    if (!month) {
      const { rows: off } = await query(
        `SELECT t.id, lower(t.during) AS from_ts, upper(t.during) AS to_ts, t.reason,
                s.slug AS stylist_slug
           FROM time_off t
           LEFT JOIN stylists s ON s.id = t.stylist_id
          WHERE t.tenant_id = $1::uuid
            AND t.during && tstzrange($2::timestamptz, $3::timestamptz, '[]')
          ORDER BY lower(t.during)`,
        [tenant.id, from.toISO(), to.toISO()],
      );
      blocks = off.map((b) => ({
        id: b.id,
        stylistSlug: b.stylist_slug,      // null: the whole salon is closed
        startsAt: b.from_ts,
        endsAt: b.to_ts,
        kind: /lunch|break/i.test(b.reason) ? 'lunch' : 'block',
        reason: b.reason,
      }));
    }

    // Each stylist's working hours that day, for the day view only (asked
    // for 2026-10-31): the grid greys out the time outside them and will
    // not book there. The same stylist_hours rows availability.js offers
    // from, so the grid, the desk's booking form and the website agree. A
    // stylist with no hours that day is listed with none: off all day.
    // Somebody with no chair is not listed, and their column is not greyed.
    let hours = {};
    if (!month) {
      const { rows: shifts } = await query(
        `SELECT s.slug, to_char(h.starts_at, 'HH24:MI') AS opens, to_char(h.ends_at, 'HH24:MI') AS closes
           FROM stylists s
           LEFT JOIN stylist_hours h ON h.stylist_id = s.id AND h.weekday = $2::int
          WHERE s.tenant_id = $1::uuid AND s.active
          ORDER BY s.slug, h.starts_at`,
        [tenant.id, day.weekday % 7],
      ).catch(() => ({ rows: [] }));
      const mins = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
      for (const r of shifts) {
        hours[r.slug] ||= [];
        if (r.opens && r.closes) hours[r.slug].push([mins(r.opens), mins(r.closes)]);
      }
    }

    // Google, for the day view only, one call per connected person, side by
    // side. A person whose Google refuses still gets their column, saying so,
    // rather than an empty one that reads as a free day.
    let team = [];
    // Signed in with Google (needs the site's OAuth client), or connected by
    // the calendar's private iCal address (google-ics.js). Through to_jsonb
    // so this still runs before migrations 010 and 018.
    if (!month) {
      const { rows: linked } = await query(
        `SELECT u.id, u.name, u.role, u.avatar,
                to_jsonb(u) ->> 'google_email' AS google_email,
                (to_jsonb(u) ->> 'google_refresh_token') IS NOT NULL AS signed_in,
                to_jsonb(u) ->> 'google_ics' AS google_ics,
                s.slug AS stylist_slug, to_jsonb(s) ->> 'photo' AS photo
           FROM staff_users u
           LEFT JOIN stylists s ON s.staff_user_id = u.id
          WHERE u.tenant_id = $1::uuid AND u.status = 'active'
            AND ((to_jsonb(u) ->> 'google_refresh_token') IS NOT NULL
                 OR (to_jsonb(u) ->> 'google_ics') IS NOT NULL)
          ORDER BY u.name`,
        [tenant.id],
      ).catch(() => ({ rows: [] }));
      team = await Promise.all(linked.map(async (u) => {
        const col = {
          id: u.id, name: u.name, role: u.role, avatar: u.avatar, photo: u.photo,
          // Which Google account is connected is the person's own detail:
          // shown to them and to the admin, not to every colleague.
          stylistSlug: u.stylist_slug,
          account: u.id === user.id || canManageTeam(user) ? u.google_email : null,
          busy: [], error: null,
        };
        try {
          // The sign-in first when there is one; the pasted address otherwise.
          const busy = u.signed_in && googleConfigured()
            ? await busyBetween(u.id, from.toISO(), to.toISO())
            : u.google_ics
              ? await icsBusyBetween(openLink(u.google_ics), from.toISO(), to.toISO(), tenant.timezone)
              : null;
          if (busy === null) col.error = 'Google disconnected. Connect it again from their profile.';
          else col.busy = busy;
        } catch (err) {
          console.error('google busy failed', u.id, err.message);
          col.error = 'Google did not answer. Try again in a moment.';
        }
        return col;
      }));
    }

    return json(res, 200, {
      date,
      blocks,
      hours,
      team,
      month: month ? month.toFormat('yyyy-MM') : null,
      timezone: tenant.timezone,
      today: DateTime.now().setZone(tenant.timezone).toISODate(),
      heading: month
        ? month.toFormat('LLLL yyyy')
        : day.toFormat('cccc d LLLL yyyy'),
      booked: appointments.filter((a) => a.status !== 'cancelled').length,
      arriving: appointments.filter((a) => a.status === 'booked' && !a.checkedInAt).length,
      appointments,
    });
  },

  async POST(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);
    const body = await readJson(req);

    const kind = body.kind === 'lunch' ? 'lunch' : 'block';
    const slug = requireString(body.stylist, 'Stylist', { max: 60 });
    const start = DateTime.fromISO(requireString(body.start, 'Start', { max: 40 }), { zone: tenant.timezone });
    if (!start.isValid) throw new HttpError(400, 'Start must be a date and time.');
    const minutes = Math.round(Number(body.minutes));
    if (!Number.isFinite(minutes) || minutes < 15 || minutes > 12 * 60) {
      throw new HttpError(400, 'A block is between 15 minutes and 12 hours.');
    }
    const reason = kind === 'lunch'
      ? 'Lunch'
      : (String(body.reason || '').trim().slice(0, 120) || 'Blocked');

    const { rows } = await query(
      `INSERT INTO time_off (tenant_id, stylist_id, during, reason)
       SELECT $1::uuid, s.id,
              tstzrange($3::timestamptz, $3::timestamptz + make_interval(mins => $4::int), '[)'),
              $5::text
         FROM stylists s WHERE s.tenant_id = $1::uuid AND s.slug = $2::text
       RETURNING id`,
      [tenant.id, slug, start.toISO(), minutes, reason],
    );
    if (!rows[0]) throw new HttpError(404, 'No such stylist.');
    // A copy in the stylist's Google Calendar when they signed in with
    // Google, so their phone shows the time as taken too. The block is
    // saved either way: Google being slow or refusing never undoes it, and
    // the answer does not wait for Google (waitUntil finishes the copy).
    if (googleConfigured()) waitUntil((async () => {
      const { rows: who } = await query(
        `SELECT u.id FROM stylists s JOIN staff_users u ON u.id = s.staff_user_id
          WHERE s.tenant_id = $1::uuid AND s.slug = $2::text
            AND (to_jsonb(u) ->> 'google_refresh_token') IS NOT NULL`,
        [tenant.id, slug],
      ).catch(() => ({ rows: [] }));
      for (const u of who) {
        await pushBlock(u.id, {
          id: rows[0].id, reason, startsAt: start.toISO(), endsAt: start.plus({ minutes }).toISO(),
        }, tenant.timezone, tenant.name).catch((err) => console.error('google block copy failed', rows[0].id, err.message));
      }
    })());
    return json(res, 201, { ok: true, id: rows[0].id, kind });
  },

  async DELETE(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);
    const body = await readJson(req);
    const id = Number(body.id);
    if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Block is not valid.');
    // Which Google copies it has, read first: the rows that name them go
    // with the block. They are taken out of Google after the answer.
    const { rows: copies } = await query(
      `SELECT g.staff_user_id, g.event_id, g.calendar_id FROM google_blocks g
         JOIN time_off t ON t.id = g.time_off_id
        WHERE g.time_off_id = $1::int AND t.tenant_id = $2::uuid`,
      [id, tenant.id],
    ).catch(() => ({ rows: [] }));
    const { rowCount } = await query(
      'DELETE FROM time_off WHERE id = $1::int AND tenant_id = $2::uuid',
      [id, tenant.id],
    );
    if (!rowCount) throw new HttpError(404, 'That block is already gone.');
    if (copies.length) {
      waitUntil(Promise.all(copies.map((c) => dropBlock(c.staff_user_id, c.event_id, c.calendar_id)
        .catch((err) => console.error('google block removal failed', id, err.message)))));
    }
    return json(res, 200, { ok: true, id });
  },
});
