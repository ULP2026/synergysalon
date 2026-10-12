/**
 * Keeping a copy of each booking in the stylist's own Google Calendar.
 *
 * The Synergy Calendar (this database) is the record; Google gets a copy for
 * stylists who signed in with Google, so a client booked on the website or at
 * the desk shows up on their phone. A pasted private address can only be
 * read, so those stylists are skipped (their salon bookings still reach them
 * through their own calendar feed, /calendar/<token>.ics). CENTRO is told
 * separately, through sync_outbox, and is never affected by this.
 *
 * Nothing waits on it: it runs after the booking is saved, from the same
 * places that nudge the CENTRO queue (drain in cron/sync.js), and again from
 * the daily cron, so a copy that failed is put right later. An appointment
 * needs pushing when it has no copy yet, or changed after its copy did.
 */
import { query } from './db.js';
import { googleConfigured, pushEvent } from './google.js';

/** Swapped out by the tests, which have no Google to talk to. */
let push = pushEvent;
export function setGooglePushForTests(fn) { push = fn || pushEvent; }

export async function mirrorToGoogle({ limit = 20, tenantId = null } = {}) {
  if (!googleConfigured() && push === pushEvent) return [];
  // Through to_jsonb so this is harmless before migration 010.
  const { rows } = await query(
    `SELECT a.*, s.name AS stylist_name, v.name AS service_name, u.id AS staff_user_id,
            t.timezone
       FROM appointments a
       JOIN stylists s ON s.id = a.stylist_id
       JOIN services v ON v.id = a.service_id
       JOIN tenants t ON t.id = a.tenant_id
       JOIN staff_users u ON u.id = s.staff_user_id
       LEFT JOIN google_events g ON g.appointment_id = a.id AND g.staff_user_id = u.id
      WHERE (to_jsonb(u) ->> 'google_refresh_token') IS NOT NULL
        AND ($1::uuid IS NULL OR a.tenant_id = $1::uuid)
        AND a.starts_at > now() - interval '1 day'
        AND ((g.event_id IS NULL AND a.status::text <> 'cancelled')
             OR (g.event_id IS NOT NULL AND g.updated_at < a.updated_at))
      ORDER BY a.updated_at
      LIMIT $2::int`,
    [tenantId, limit],
  ).catch((err) => { console.error('google mirror query failed', err.message); return { rows: [] }; });

  const done = [];
  for (const appt of rows) {
    try {
      done.push({ ref: appt.ref, event: await push(appt.staff_user_id, appt, appt.timezone) });
    } catch (err) {
      console.error('google mirror failed for', appt.ref, err.message);
    }
  }
  return done;
}

/**
 * Before an appointment is deleted outright: its Google copies go too, or
 * they would sit in the stylist's calendar with nothing behind them (the
 * google_events rows cascade away with the appointment).
 */
export async function removeGoogleCopies(appt, serviceName) {
  const { rows } = await query(
    `SELECT g.staff_user_id, t.timezone FROM google_events g
       JOIN appointments a ON a.id = g.appointment_id
       JOIN tenants t ON t.id = a.tenant_id
      WHERE g.appointment_id = $1`,
    [appt.id],
  ).catch(() => ({ rows: [] }));
  for (const r of rows) {
    try {
      await push(r.staff_user_id, { ...appt, service_name: serviceName || '', status: 'cancelled' }, r.timezone);
    } catch (err) {
      console.error('google copy removal failed for', appt.ref, err.message);
    }
  }
}
