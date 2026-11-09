/**
 * Keeping a copy of each booking in the stylist's own Google Calendar.
 *
 * The Synergy Calendar (this database) is the record; Google gets a copy for
 * stylists who signed in with Google, so a client booked on the website or at
 * the desk shows up on their phone. A pasted private address can only be
 * read, so those stylists are skipped (their salon bookings still reach them
 * through their own calendar feed, /calendar/<token>.ics).
 *
 * Nothing waits on it: it runs after a booking or a change is saved, and
 * again from the daily cron (cron/sync.js), so a copy that failed is put
 * right later. An appointment
 * needs pushing when it has no copy yet, or changed after its copy did.
 */
import { query } from './db.js';
import { chairLoginJoin } from './google-busy.js';
import { googleConfigured, pushEvent } from './google.js';
import { visitNameSql } from './visit.js';

/** Swapped out by the tests, which have no Google to talk to. */
let push = pushEvent;
export function setGooglePushForTests(fn) { push = fn || pushEvent; }

/**
 * `appointmentId`: the one just changed, done first. Both lists run newest
 * change first (2026-11-09): oldest first, twenty copies that kept failing
 * sat at the head of the queue and a move made at the desk waited for the
 * nightly run, while the stylist's phone still showed the old time.
 */
export async function mirrorToGoogle({ limit = 20, tenantId = null, appointmentId = null } = {}) {
  if (!googleConfigured() && push === pushEvent) return [];
  const done = [];

  // A copy left with somebody the appointment no longer belongs to (moved
  // to another stylist, 2026-11-09): taken out of their calendar. Before
  // this the old stylist's phone kept the visit at its old time for good.
  const { rows: stale } = await query(
    `SELECT a.*, ${visitNameSql()} AS service_name, g.staff_user_id AS copy_owner, t.timezone, t.name AS salon_name
       FROM google_events g
       JOIN appointments a ON a.id = g.appointment_id
       JOIN stylists s ON s.id = a.stylist_id
       JOIN services v ON v.id = a.service_id
       JOIN tenants t ON t.id = a.tenant_id
       ${chairLoginJoin('s', 'u')}
      WHERE g.staff_user_id IS DISTINCT FROM u.id
        AND ($1::uuid IS NULL OR a.tenant_id = $1::uuid)
        AND a.starts_at > now() - interval '1 day'
      ORDER BY (a.id = $3::uuid) DESC NULLS LAST, a.updated_at DESC
      LIMIT $2::int`,
    [tenantId, limit, appointmentId],
  ).catch((err) => { console.error('google mirror (moved copies) query failed', err.message); return { rows: [] }; });
  for (const appt of stale) {
    try {
      await push(appt.copy_owner, { ...appt, status: 'cancelled' }, appt.timezone);
      await query('DELETE FROM google_events WHERE appointment_id = $1::uuid AND staff_user_id = $2::uuid',
        [appt.id, appt.copy_owner]);
      done.push({ ref: appt.ref, removedFrom: appt.copy_owner });
    } catch (err) {
      console.error('google copy of a moved appointment not removed for', appt.ref, err.message);
    }
  }

  // Through to_jsonb so this is harmless before migration 010.
  const { rows } = await query(
    `SELECT a.*, s.name AS stylist_name, ${visitNameSql()} AS service_name, u.id AS staff_user_id,
            t.timezone, t.name AS salon_name
       FROM appointments a
       JOIN stylists s ON s.id = a.stylist_id
       JOIN services v ON v.id = a.service_id
       JOIN tenants t ON t.id = a.tenant_id
       ${chairLoginJoin('s', 'u')}
       LEFT JOIN google_events g ON g.appointment_id = a.id AND g.staff_user_id = u.id
      WHERE u.id IS NOT NULL AND (to_jsonb(u) ->> 'google_refresh_token') IS NOT NULL
        AND ($1::uuid IS NULL OR a.tenant_id = $1::uuid)
        AND a.starts_at > now() - interval '1 day'
        AND ((g.event_id IS NULL AND a.status::text <> 'cancelled')
             OR (g.event_id IS NOT NULL AND g.updated_at < a.updated_at))
      ORDER BY (a.id = $3::uuid) DESC NULLS LAST, a.updated_at DESC
      LIMIT $2::int`,
    [tenantId, limit, appointmentId],
  ).catch((err) => { console.error('google mirror query failed', err.message); return { rows: [] }; });

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
