/**
 * GET /api/cron/reminders — the day-before nudge, run hourly by Vercel Cron.
 *
 * Reminders are the cheapest thing a salon can do about no-shows, and a
 * no-show on a three-hour colour appointment is most of a day's takings.
 *
 * Sending is recorded per appointment, so running this twice never emails
 * anyone twice, and a missed run simply catches up on the next pass.
 */
import { REMINDER_LEAD_HOURS } from '../_lib/config.js';
import { query } from '../_lib/db.js';
import { sendReminder } from '../_lib/email.js';
import { handler, json } from '../_lib/http.js';

export default handler({
  async GET(req, res) {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.authorization !== `Bearer ${secret}`) {
      return json(res, 401, { error: 'Unauthorized' });
    }

    const { rows } = await query(
      `SELECT a.id, a.ref, a.starts_at, a.duration_min, a.price_cents,
              a.guest_name, a.guest_email, a.manage_token,
              s.name AS stylist_name, v.name AS service_name,
              -- The shop each guest is being reminded about, so one run can
              -- cover several and each email speaks for the right one.
              t.timezone, t.name AS shop_name, t.host, t.slug,
              t.address, t.phone, t.email
         FROM appointments a
         JOIN stylists s ON s.id = a.stylist_id
         JOIN services v ON v.id = a.service_id
         JOIN tenants t ON t.id = a.tenant_id
        WHERE a.status = 'booked'
          AND a.reminder_sent_at IS NULL
          AND a.starts_at > now()
          AND a.starts_at <= now() + make_interval(hours => $1::int)
          AND a.guest_email <> ''
        ORDER BY a.starts_at
        LIMIT 200`,
      [REMINDER_LEAD_HOURS],
    );

    let sent = 0;
    const failed = [];
    for (const appt of rows) {
      try {
        await sendReminder(appt, {
          name: appt.shop_name, timezone: appt.timezone, host: appt.host,
          slug: appt.slug, address: appt.address, phone: appt.phone, email: appt.email,
        });
        // Marked only after the provider accepted it, so a failure is retried
        // on the next run rather than silently dropped.
        await query('UPDATE appointments SET reminder_sent_at = now() WHERE id = $1', [appt.id]);
        sent += 1;
      } catch (err) {
        console.error('reminder failed for', appt.ref, err);
        failed.push(appt.ref);
      }
    }

    return json(res, 200, { considered: rows.length, sent, failed });
  },
});
