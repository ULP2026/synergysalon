/**
 * GET /api/cron/followups — sends whatever in the queue is due.
 *
 * The other half of scheduled.js. Triggers write rows; this drains them.
 * Everything from M4 to M11 in the automation catalog arrives through here,
 * which is why there is one job rather than one per module: a new follow-up
 * is a new row and a new template, not a new cron and a new function. Vercel's
 * Hobby plan allows twelve functions and a daily schedule, and both were
 * nearly spent.
 *
 * Due means send_after has passed, so on a once-a-day schedule a message
 * meant for "+3 hours" goes out on the next run. scheduled.js says why the
 * intent is stored unrounded anyway.
 *
 * Every send is marked before the next is attempted, so a run that dies
 * halfway never repeats what it already sent. A failure is left unsent and
 * retried tomorrow rather than being dropped, which matches how the reminder
 * job has always behaved.
 */
import { query } from '../_lib/db.js';
import { sendKind } from '../_lib/email.js';
import { handler, json } from '../_lib/http.js';
import { visitLinesSql, visitNameSql } from '../_lib/visit.js';

/** How far back to look. Older than this and the moment has simply passed. */
const STALE_DAYS = 14;

/**
 * The three modules with no event to hang off.
 *
 * M4 to M8 all follow something that happens -- a booking, a no-show, a
 * checkout -- so a trigger queues them. M9, M10 and M11 are the absence of
 * something: nothing booked, nobody seen in months. Nothing fires when a
 * guest does not come back, so they are swept for instead, here, each run.
 *
 * All three are written as "queue one row per guest who has newly become
 * due", and the unique index plus the not-exists guards make a second run
 * over the same guest a no-op. The queue, not this query, decides whether a
 * message is actually sent.
 */
async function sweep() {
  // M9 Rebook: their last visit was a service with a natural interval, that
  // interval has passed, and they have nothing in the diary.
  const rebook = await query(
    `INSERT INTO scheduled_messages
       (tenant_id, kind, appointment_id, contact_id, to_name, to_email, send_after)
     SELECT a.tenant_id, 'rebook_due', a.id, a.contact_id, a.guest_name, a.guest_email, now()
       FROM appointments a
       JOIN services v ON v.id = a.service_id
      WHERE a.status = 'completed'
        AND a.guest_email <> ''
        AND v.rebook_days IS NOT NULL
        AND a.starts_at < now() - make_interval(days => v.rebook_days)
        AND a.starts_at > now() - make_interval(days => v.rebook_days + 14)
        AND NOT EXISTS (
          SELECT 1 FROM appointments f
           WHERE f.contact_id = a.contact_id AND f.status = 'booked' AND f.starts_at > now())
     ON CONFLICT DO NOTHING`,
  ).catch((e) => { console.warn('sweep rebook', e.message); return { rowCount: 0 }; });

  // M10 Second visit: one completed appointment ever, a few days ago, and
  // nothing booked since.
  const second = await query(
    `INSERT INTO scheduled_messages
       (tenant_id, kind, appointment_id, contact_id, to_name, to_email, send_after)
     SELECT a.tenant_id, 'second_visit', a.id, a.contact_id, a.guest_name, a.guest_email, now()
       FROM appointments a
      WHERE a.status = 'completed'
        AND a.guest_email <> ''
        AND a.starts_at < now() - interval '5 days'
        AND a.starts_at > now() - interval '19 days'
        AND NOT EXISTS (
          SELECT 1 FROM appointments o
           WHERE o.contact_id = a.contact_id AND o.id <> a.id
             AND (o.status = 'completed' OR (o.status = 'booked' AND o.starts_at > now())))
     ON CONFLICT DO NOTHING`,
  ).catch((e) => { console.warn('sweep second', e.message); return { rowCount: 0 }; });

  // M11 Win-back: not seen in 90 days, nothing booked, and not already asked.
  // Keyed on the contact rather than an appointment, because this is about a
  // person who is not in the diary at all.
  const back = await query(
    `INSERT INTO scheduled_messages
       (tenant_id, kind, contact_id, to_name, to_email, send_after)
     SELECT c.tenant_id, 'win_back', c.id, c.name, c.email, now()
       FROM contacts c
      WHERE c.email <> ''
        AND c.last_visit_at IS NOT NULL
        AND c.last_visit_at < now() - interval '90 days'
        AND c.last_visit_at > now() - interval '180 days'
        AND NOT EXISTS (
          SELECT 1 FROM appointments f
           WHERE f.contact_id = c.id AND f.status = 'booked' AND f.starts_at > now())
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_messages m
           WHERE m.contact_id = c.id AND m.kind = 'win_back')`,
  ).catch((e) => { console.warn('sweep winback', e.message); return { rowCount: 0 }; });

  return { rebook: rebook.rowCount, second: second.rowCount, winBack: back.rowCount };
}

export default handler({
  async GET(req, res) {
    if (process.env.CRON_SECRET
      && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return json(res, 401, { error: 'Not for you.' });
    }

    // Queue anything that has newly become due before draining, so a guest
    // who crossed a threshold today is served on the same run rather than
    // waiting another day for it.
    const queued = await sweep();

    // Everything the templates read, in one pass: the queued row, the
    // appointment it is about where there is one, and the salon it belongs
    // to. A queued message whose appointment has since been cancelled is
    // dropped here rather than sent -- "we missed you today" about an
    // appointment nobody was expecting reads as a mistake.
    const { rows } = await query(
      `SELECT m.id, m.kind, m.to_name, m.to_email, m.appointment_id,
              a.ref, a.starts_at, a.duration_min, a.price_cents, a.manage_token,
              a.status AS appt_status, a.guest_name, a.guest_email,
              s.name AS stylist_name, ${visitNameSql()} AS service_name, ${visitLinesSql()} AS lines,
              t.id AS tenant_id, t.name AS shop_name, t.timezone, t.host, t.slug,
              t.address, t.phone, t.email,
              to_jsonb(t) -> 'automations_off' AS automations_off,
              to_jsonb(t) ->> 'review_url' AS review_url,
              -- The client's own say (migration 031); yes where unset.
              COALESCE((to_jsonb(c) ->> 'email_ok')::boolean, true) AS email_ok
         FROM scheduled_messages m
         JOIN tenants t ON t.id = m.tenant_id
         LEFT JOIN appointments a ON a.id = m.appointment_id
         LEFT JOIN contacts c ON c.id = COALESCE(m.contact_id, a.contact_id)
         LEFT JOIN stylists s ON s.id = a.stylist_id
         LEFT JOIN services v ON v.id = a.service_id
        WHERE m.sent_at IS NULL
          AND m.cancelled_at IS NULL
          AND m.send_after <= now()
          AND m.send_after > now() - make_interval(days => $1::int)
        ORDER BY m.send_after
        LIMIT 200`,
      [STALE_DAYS],
    );

    let sent = 0;
    let off = 0;
    const skipped = [];
    const failed = [];

    for (const row of rows) {
      // Cancelled since it was queued: the follow-up is about something that
      // is no longer happening.
      if (row.appointment_id && row.appt_status === 'cancelled'
        && !['late_cancel', 'win_back', 'rebook_due'].includes(row.kind)) {
        await query(
          `UPDATE scheduled_messages SET cancelled_at = now(), cancel_reason = $2 WHERE id = $1`,
          [row.id, 'appointment cancelled'],
        );
        skipped.push(row.kind);
        continue;
      }

      // The client asked not to be sent follow-up emails. Cancelled, not
      // held, for the same reason a switched-off automation's are.
      if (!row.email_ok) {
        await query(
          `UPDATE scheduled_messages SET cancelled_at = now(), cancel_reason = $2 WHERE id = $1`,
          [row.id, 'client opted out of email'],
        );
        skipped.push(row.kind);
        continue;
      }

      const tenant = {
        id: row.tenant_id,
        name: row.shop_name,
        timezone: row.timezone,
        host: row.host,
        slug: row.slug,
        address: row.address,
        phone: row.phone,
        email: row.email,
        automations_off: row.automations_off,
        review_url: row.review_url,
      };

      // The templates read an appointment. A message about a person rather
      // than a booking (a win-back) has none, so the queue's own name and
      // address stand in for it.
      const appt = {
        id: row.appointment_id,
        ref: row.ref,
        starts_at: row.starts_at,
        duration_min: row.duration_min,
        price_cents: row.price_cents,
        manage_token: row.manage_token,
        guest_name: row.guest_name || row.to_name,
        guest_email: row.to_email,
        stylist_name: row.stylist_name || 'the team',
        service_name: row.service_name || 'your appointment',
        lines: row.lines,
      };

      try {
        const out = await sendKind(row.kind, appt, tenant);
        if (out?.off) {
          // Switched off in Marketing. Cancelled rather than left pending, so
          // it does not fire weeks later if the salon turns it back on: the
          // moment it was for has gone.
          await query(
            `UPDATE scheduled_messages SET cancelled_at = now(), cancel_reason = $2 WHERE id = $1`,
            [row.id, 'automation switched off'],
          );
          off += 1;
          continue;
        }
        // Marked only once the provider has taken it, so a failure is retried
        // tomorrow rather than silently dropped.
        await query('UPDATE scheduled_messages SET sent_at = now() WHERE id = $1', [row.id]);
        sent += 1;
      } catch (err) {
        console.error('follow-up failed', row.kind, row.to_email, err.message);
        failed.push(row.kind);
      }
    }

    return json(res, 200, { queued, due: rows.length, sent, off, skipped: skipped.length, failed });
  },
});
