/**
 * GET /api/calendar?k=<token> — one stylist's diary, as a calendar feed.
 *
 * Subscribed to once in Google, Apple or Outlook, after which their own
 * calendar app keeps it up to date. Read-only on purpose: the salon's diary
 * lives in Postgres, and a stylist dragging an appointment in their phone
 * calendar must not be able to move a client's booking.
 *
 * The token is the credential. There is no session here, because a calendar
 * app cannot sign in — it fetches this URL on a timer, from a server, with no
 * cookie. That is the same bargain every calendar subscription makes, and it
 * is why the token is 64 random hex characters, is never shown beside a
 * stylist's name in public, and can be regenerated without touching a single
 * appointment.
 */
import { DateTime } from 'luxon';

import { query } from './_lib/db.js';
import { handler, json } from './_lib/http.js';

/** How much of the diary a phone needs: enough history to look back, a season ahead. */
const DAYS_BACK = 60;
const DAYS_AHEAD = 240;

/**
 * Escape a value for iCalendar text. Commas, semicolons and backslashes are
 * structural in this format, and a client's name containing one would
 * otherwise split the field.
 */
function ics(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Fold to 75 octets, which the spec requires and some clients enforce by
 * simply truncating. Measured in bytes rather than characters so an accented
 * name cannot push a line over the limit unnoticed.
 */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = [];
  let start = 0;
  while (start < bytes.length) {
    const width = out.length === 0 ? 75 : 74;
    let end = Math.min(start + width, bytes.length);
    // Never split a multi-byte character across two lines.
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    out.push((out.length ? ' ' : '') + bytes.slice(start, end).toString('utf8'));
    start = end;
  }
  return out.join('\r\n');
}

const stamp = (d) => DateTime.fromJSDate(new Date(d)).toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");

export default handler({
  async GET(req, res) {
    const url = new URL(req.url, 'http://localhost');
    // Accept the token from the path too, so the URL can end in .ics — some
    // clients refuse to subscribe to anything that does not look like a file.
    const token = (url.searchParams.get('k') || '').replace(/\.ics$/, '').trim();

    if (!/^[0-9a-f]{64}$/.test(token)) {
      return json(res, 404, { error: 'No calendar here.' });
    }

    // A link belongs to a person. If that person also stands behind a chair,
    // the feed is their own appointments; if they do not -- an owner, the
    // front desk -- it is the whole shop's day, which is what they are
    // actually trying to see.
    const { rows: found } = await query(
      `SELECT u.tenant_id, u.name, s.id AS stylist_id, s.name AS stylist_name,
              t.name AS salon, t.timezone
         FROM staff_users u
         JOIN tenants t ON t.id = u.tenant_id
         LEFT JOIN stylists s ON s.staff_user_id = u.id AND s.active
        WHERE u.calendar_token = $1 AND u.active AND t.active
        UNION ALL
       -- Links handed out before a calendar belonged to a person. Kept
       -- working so nobody's phone quietly stops updating.
       SELECT s.tenant_id, s.name, s.id, s.name, t.name, t.timezone
         FROM stylists s
         JOIN tenants t ON t.id = s.tenant_id
        WHERE s.calendar_token = $1 AND s.active AND t.active
        LIMIT 1`,
      [token],
    );
    const owner = found[0];
    // The same answer as a malformed token: a valid-looking one that is not
    // ours should not be distinguishable from one that never existed.
    if (!owner) return json(res, 404, { error: 'No calendar here.' });

    // Nothing tells us when somebody subscribes, so the fetch itself is the
    // evidence. Recorded before the body is built: a calendar service that
    // times out mid-response still came and asked, and the person is still
    // connected. Failing to write it must never fail the feed.
    query(
      `UPDATE staff_users
          SET calendar_last_fetch = now(),
              calendar_fetches = calendar_fetches + 1,
              calendar_last_agent = left($2, 200)
        WHERE calendar_token = $1`,
      [token, String(req.headers['user-agent'] || '')],
    ).catch((err) => console.error('calendar check-in not recorded', err));

    const wholeShop = !owner.stylist_id;
    const stylist = {
      name: wholeShop ? owner.salon : owner.stylist_name,
      salon: owner.salon,
      timezone: owner.timezone,
    };

    const from = DateTime.now().minus({ days: DAYS_BACK }).toISO();
    const to = DateTime.now().plus({ days: DAYS_AHEAD }).toISO();

    const { rows } = await query(
      `SELECT a.ref, a.starts_at, a.duration_min, a.status, a.updated_at,
              a.guest_name, a.guest_email, a.guest_phone, a.notes,
              v.name AS service_name, st.name AS stylist_name
         FROM appointments a
         JOIN services v ON v.id = a.service_id
         JOIN stylists st ON st.id = a.stylist_id
        WHERE ($1::uuid IS NULL OR a.stylist_id = $1::uuid)
          AND a.tenant_id = $4
          AND a.starts_at >= $2 AND a.starts_at <= $3
        ORDER BY a.starts_at`,
      [owner.stylist_id, from, to, owner.tenant_id],
    );

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Synergy Salon//Staff diary//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      // A stylist's feed says whose it is; the shop-wide one is just the shop,
      // rather than its own name twice.
      `X-WR-CALNAME:${ics(wholeShop ? stylist.salon : `${stylist.name} · ${stylist.salon}`)}`,
      `X-WR-TIMEZONE:${ics(stylist.timezone)}`,
      // Most clients treat this as a hint, not an instruction, but it is the
      // only way to ask for anything faster than their own default.
      'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
      'X-PUBLISHED-TTL:PT15M',
    ];

    for (const r of rows) {
      const starts = new Date(r.starts_at);
      const ends = DateTime.fromJSDate(starts).plus({ minutes: r.duration_min });
      const detail = [
        r.guest_phone && `Phone: ${r.guest_phone}`,
        r.guest_email && `Email: ${r.guest_email}`,
        r.notes,
        `Ref ${r.ref}`,
      ].filter(Boolean).join('\n');

      lines.push(
        'BEGIN:VEVENT',
        // Stable across every refresh, so an edit updates the event the
        // stylist already has rather than adding a second one beside it.
        `UID:${ics(r.ref)}@synergysalon.com`,
        `DTSTAMP:${stamp(r.updated_at || starts)}`,
        `DTSTART:${stamp(starts)}`,
        `DTEND:${stamp(ends.toJSDate())}`,
        `SUMMARY:${ics(wholeShop
          ? `${r.guest_name} · ${r.service_name} (${r.stylist_name})`
          : `${r.guest_name} · ${r.service_name}`)}`,
        `DESCRIPTION:${ics(detail)}`,
        // Cancelled appointments are sent rather than dropped: a client who
        // vanishes from the feed silently is one the stylist still turns up
        // for. This tells the calendar to remove it.
        `STATUS:${r.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
        r.status === 'cancelled' ? 'METHOD:CANCEL' : 'TRANSP:OPAQUE',
        'END:VEVENT',
      );
    }
    lines.push('END:VCALENDAR');

    res.status(200);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="synergy-salon.ics"');
    // Calendar clients poll on their own schedule; a few minutes of edge cache
    // keeps a busy salon from being re-queried for every device.
    res.setHeader('Cache-Control', 'public, max-age=300');
    // A URL that reveals a stylist's day should never turn up in a search index.
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.end(lines.map(fold).join('\r\n') + '\r\n');
  },
});
