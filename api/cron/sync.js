/**
 * GET /api/cron/sync — drains sync_outbox into CENTRO.
 *
 * Runs on a schedule and can also be called directly after a booking to make
 * the mirror feel instant. Either way the work is the same and running it
 * twice is safe: each row is claimed before it is sent, and every push is
 * keyed on an id we store, so a retry updates rather than duplicates.
 *
 * Failures back off rather than spin. A CRM that is struggling should not be
 * hit harder because we have a queue.
 */
import { DateTime } from 'luxon';

import { pool, query, transaction } from '../_lib/db.js';
import {
  GhlError, cancelAppointment, createAppointment, updateAppointment, upsertContact,
} from '../_lib/ghl.js';
import { handler, json } from '../_lib/http.js';

const BATCH = 25;
const MAX_ATTEMPTS = 8;

/** 1, 2, 4, 8 … minutes, capped, so a long outage does not become a hot loop. */
function backoffMinutes(attempts) {
  return Math.min(2 ** attempts, 360);
}

/**
 * Claim one job for this run.
 *
 * SKIP LOCKED is what makes it safe for two overlapping runs, or a cron and a
 * post-booking nudge, to drain the queue at once without both sending the
 * same appointment.
 */
async function claim(client) {
  const { rows } = await client.query(
    `SELECT o.*, t.id AS tenant_id, t.timezone,
            t.ghl_location_id, t.ghl_token, t.ghl_calendar_id
       FROM sync_outbox o
       JOIN tenants t ON t.id = o.tenant_id
      WHERE o.state = 'pending' AND o.next_try_at <= now()
        AND t.ghl_token IS NOT NULL
      ORDER BY o.next_try_at
      FOR UPDATE OF o SKIP LOCKED
      LIMIT 1`,
  );
  return rows[0] ?? null;
}

async function loadAppointment(client, id) {
  const { rows } = await client.query(
    `SELECT a.*, s.name AS stylist_name, v.name AS service_name,
            ct.ghl_contact_id AS contact_ghl_id
       FROM appointments a
       JOIN stylists s ON s.id = a.stylist_id
       JOIN services v ON v.id = a.service_id
       LEFT JOIN contacts ct ON ct.id = a.contact_id
      WHERE a.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function pushAppointment(client, job, tenant) {
  const appt = await loadAppointment(client, job.appointment_id);
  // The appointment was deleted outright. Nothing to mirror.
  if (!appt) return { skipped: 'appointment no longer exists' };

  const title = `${appt.service_name} with ${appt.stylist_name}`;
  const startsAt = DateTime.fromJSDate(new Date(appt.starts_at)).setZone(tenant.timezone);
  // The guest's own end time, not the end of the clean-down buffer: CENTRO
  // shows this to the client, and they did not book fifteen minutes of
  // sweeping up.
  const endsAt = startsAt.plus({ minutes: appt.duration_min });

  if (job.kind === 'appointment.cancelled') {
    if (!appt.ghl_appointment_id) return { skipped: 'never reached CENTRO' };
    await cancelAppointment(tenant, appt.ghl_appointment_id);
    return { cancelled: appt.ghl_appointment_id };
  }

  if (appt.ghl_appointment_id) {
    await updateAppointment(tenant, appt.ghl_appointment_id, {
      startsAt: startsAt.toISO(), endsAt: endsAt.toISO(), title,
    });
    return { updated: appt.ghl_appointment_id };
  }

  const contactId = appt.contact_ghl_id ?? await upsertContact(tenant, {
    name: appt.guest_name,
    email: appt.guest_email,
    phone: appt.guest_phone,
    source: appt.channel === 'staff' ? 'Staff booking' : 'synergysalon.com',
    tags: ['booked-online'],
  });

  const eventId = await createAppointment(tenant, {
    contactId,
    startsAt: startsAt.toISO(),
    endsAt: endsAt.toISO(),
    title,
    notes: [appt.notes, `Ref ${appt.ref}`].filter(Boolean).join('\n'),
  });

  // Stored before the job is marked done, so a crash in between means the
  // retry updates this appointment rather than creating a second one.
  await client.query(
    'UPDATE appointments SET ghl_appointment_id = $2 WHERE id = $1',
    [appt.id, eventId],
  );
  if (appt.contact_id && !appt.contact_ghl_id) {
    await client.query(
      'UPDATE contacts SET ghl_contact_id = $2 WHERE id = $1 AND ghl_contact_id IS NULL',
      [appt.contact_id, contactId],
    );
  }
  return { created: eventId };
}

async function pushContact(client, job, tenant) {
  const { rows } = await client.query('SELECT * FROM contacts WHERE id = $1', [job.contact_id]);
  const contact = rows[0];
  if (!contact) return { skipped: 'contact no longer exists' };

  const contactId = await upsertContact(tenant, {
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    source: contact.source || 'Staff console',
    tags: ['contact'],
  });
  await client.query(
    'UPDATE contacts SET ghl_contact_id = $2, updated_at = now() WHERE id = $1',
    [contact.id, contactId],
  );
  return { contact: contactId };
}

/** Process one job. Returns a short description for the response. */
async function runOne() {
  return transaction(async (client) => {
    const job = await claim(client);
    if (!job) return null;

    const tenant = {
      id: job.tenant_id,
      timezone: job.timezone,
      ghl_location_id: job.ghl_location_id,
      ghl_token: job.ghl_token,
      ghl_calendar_id: job.ghl_calendar_id,
    };

    try {
      const result = job.kind.startsWith('appointment.')
        ? await pushAppointment(client, job, tenant)
        : await pushContact(client, job, tenant);

      await client.query(
        `UPDATE sync_outbox SET state = 'done', done_at = now(), attempts = attempts + 1
          WHERE id = $1`,
        [job.id],
      );
      return { id: job.id, kind: job.kind, ...result };
    } catch (err) {
      const attempts = job.attempts + 1;
      // A 4xx will fail identically forever: a deleted calendar, a revoked
      // token, a malformed record. Retrying it just hides it.
      const giveUp = (err instanceof GhlError && err.permanent) || attempts >= MAX_ATTEMPTS;

      await client.query(
        `UPDATE sync_outbox
            SET attempts = $2,
                last_error = $3,
                state = $4,
                next_try_at = now() + make_interval(mins => $5::int)
          WHERE id = $1`,
        [job.id, attempts, String(err.message).slice(0, 500),
          giveUp ? 'failed' : 'pending', giveUp ? 0 : backoffMinutes(attempts)],
      );
      return { id: job.id, kind: job.kind, error: err.message, state: giveUp ? 'failed' : 'pending' };
    }
  });
}

/** Exported so a booking can nudge the queue without waiting for the cron. */
export async function drain(limit = BATCH) {
  const done = [];
  for (let i = 0; i < limit; i += 1) {
    const result = await runOne();
    if (!result) break;
    done.push(result);
  }
  return done;
}

export default handler({
  async GET(req, res) {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.authorization !== `Bearer ${secret}`) {
      return json(res, 401, { error: 'Unauthorized' });
    }

    const processed = await drain();
    const { rows } = await query(
      `SELECT state, count(*)::int AS n FROM sync_outbox
        WHERE state <> 'done' GROUP BY state`,
    );
    return json(res, 200, {
      processed: processed.length,
      results: processed,
      queue: Object.fromEntries(rows.map((r) => [r.state, r.n])),
    });
  },
});

// The pool is shared with the rest of the functions; nothing to close here.
export { pool };
