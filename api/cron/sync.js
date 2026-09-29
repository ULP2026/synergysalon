/**
 * GET /api/cron/sync drains sync_outbox into CENTRO.
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
  GhlError, cancelAppointment, checkConnection, createAppointment, deleteAppointment,
  deleteContact, ghlStatusFor, updateAppointment, updateContact, upsertContact,
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
async function claim(client, tenantId = null) {
  const { rows } = await client.query(
    `SELECT o.*, t.id AS tenant_id, t.timezone,
            t.ghl_location_id, t.ghl_token, t.ghl_calendar_id, t.ghl_user_id
       FROM sync_outbox o
       JOIN tenants t ON t.id = o.tenant_id
      WHERE o.state = 'pending' AND o.next_try_at <= now()
        AND t.ghl_token IS NOT NULL
        AND ($1::uuid IS NULL OR o.tenant_id = $1::uuid)
      ORDER BY o.next_try_at
      FOR UPDATE OF o SKIP LOCKED
      LIMIT 1`,
    [tenantId],
  );
  return rows[0] ?? null;
}

async function loadAppointment(client, id) {
  const { rows } = await client.query(
    `SELECT a.*, s.name AS stylist_name, s.ghl_user_id AS stylist_ghl_user_id,
            v.name AS service_name,
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

  // Whatever the job says happened, CENTRO is told how the appointment
  // stands now. Jobs can run late and out of order (a retry after a failure,
  // a cancellation queued behind the booking it cancels), and pushing the
  // event each job describes would let an old "booked" undo a newer
  // "cancelled".
  const status = ghlStatusFor(appt);

  if (status === 'cancelled') {
    if (!appt.ghl_appointment_id) return { skipped: 'cancelled before it reached CENTRO' };
    await cancelAppointment(tenant, appt.ghl_appointment_id);
    return { cancelled: appt.ghl_appointment_id };
  }

  if (appt.ghl_appointment_id) {
    await updateAppointment(tenant, appt.ghl_appointment_id, {
      startsAt: startsAt.toISO(), endsAt: endsAt.toISO(), title, appointmentStatus: status,
    });
    return { updated: appt.ghl_appointment_id, status };
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
    assignedUserId: appt.stylist_ghl_user_id || tenant.ghl_user_id,
    startsAt: startsAt.toISO(),
    endsAt: endsAt.toISO(),
    title,
    appointmentStatus: status,
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

  // Editing somebody's email must not leave two of them in CENTRO, so once
  // we know their id we update by id rather than matching on their details.
  if (contact.ghl_contact_id) {
    await updateContact(tenant, contact.ghl_contact_id, contact);
    return { updated: contact.ghl_contact_id };
  }

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

/**
 * Mirror a deletion. The contact row is already gone, so everything needed
 * travels in the payload.
 *
 * Their upcoming appointments are cancelled before the contact is removed, so
 * CENTRO's calendar never keeps a slot blocked by somebody who no longer
 * exists, whatever CENTRO itself does with a deleted contact's events. A
 * retry repeats both steps, which is harmless: cancelling twice and deleting
 * something already gone both succeed.
 */
/**
 * An appointment the salon deleted outright.
 *
 * The CENTRO id travels in the payload rather than in appointment_id, because
 * that column cascades: deleting the appointment would delete the job that
 * tells us to clean up after it.
 */
async function removeAppointment(job, tenant) {
  const { ghlAppointmentId } = job.payload || {};
  if (!ghlAppointmentId) return { skipped: 'never reached CENTRO' };
  await deleteAppointment(tenant, ghlAppointmentId);
  return { deleted: ghlAppointmentId };
}

async function removeContact(job, tenant) {
  const { ghlContactId, ghlAppointmentIds = [] } = job.payload || {};
  for (const eventId of ghlAppointmentIds) {
    try {
      await cancelAppointment(tenant, eventId);
    } catch (err) {
      if (!(err instanceof GhlError && err.status === 404)) throw err;
    }
  }
  if (ghlContactId) await deleteContact(tenant, ghlContactId);
  return { deleted: ghlContactId ?? null, cancelled: ghlAppointmentIds.length };
}

/** Process one job. Returns a short description for the response. */
async function runOne(tenantId) {
  return transaction(async (client) => {
    const job = await claim(client, tenantId);
    if (!job) return null;

    const tenant = {
      id: job.tenant_id,
      timezone: job.timezone,
      ghl_location_id: job.ghl_location_id,
      ghl_token: job.ghl_token,
      ghl_calendar_id: job.ghl_calendar_id,
      ghl_user_id: job.ghl_user_id,
    };

    try {
      let result;
      if (job.kind === 'contact.deleted') result = await removeContact(job, tenant);
      else if (job.kind === 'appointment.deleted') result = await removeAppointment(job, tenant);
      else if (job.kind.startsWith('appointment.')) result = await pushAppointment(client, job, tenant);
      else result = await pushContact(client, job, tenant);

      await client.query(
        `UPDATE sync_outbox SET state = 'done', done_at = now(), attempts = attempts + 1
          WHERE id = $1`,
        [job.id],
      );
      return { id: job.id, kind: job.kind, ...result };
    } catch (err) {
      const attempts = job.attempts + 1;
      // Logged as well as stored: the stored error is only readable from
      // the database, and five bookings once sat failed with nobody knowing.
      console.error(`CENTRO sync job ${job.id} (${job.kind}) failed:`, err.message);
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
export async function drain(limit = BATCH, { tenantId = null } = {}) {
  const done = [];
  for (let i = 0; i < limit; i += 1) {
    const result = await runOne(tenantId);
    if (!result) break;
    done.push(result);
  }
  return done;
}

/**
 * Put failed jobs back in the queue.
 *
 * A job fails for good on a 4xx, which is right while the cause stands: a
 * wrong calendar or a revoked token will refuse it every time. Once the
 * cause is fixed those bookings still need to reach CENTRO, and nobody
 * should have to find them one by one. Only recent ones: a booking from
 * months ago is history, not something to put on the calendar now.
 */
export async function requeueFailed(tenantId) {
  const { rowCount } = await query(
    `UPDATE sync_outbox
        SET state = 'pending', attempts = 0, next_try_at = now()
      WHERE state = 'failed' AND tenant_id = $1::uuid
        AND created_at > now() - interval '30 days'`,
    [tenantId],
  );
  return rowCount;
}

/** Stylist mappings the connection check should confirm are on the calendar. */
async function mappedUsers(tenant) {
  const { rows } = await query(
    `SELECT ghl_user_id FROM stylists
      WHERE tenant_id = $1::uuid AND ghl_user_id IS NOT NULL`,
    [tenant.id],
  );
  return [tenant.ghl_user_id, ...rows.map((r) => r.ghl_user_id)];
}

/** Check a tenant's link to CENTRO; exported for the staff console. */
export async function connectionFor(tenant) {
  return checkConnection(tenant, await mappedUsers(tenant));
}

/**
 * The state of one salon's link to CENTRO, for the staff console.
 *
 * Lives here rather than in the route so the token stays where it always
 * has: read only by the sync worker, never selected by an endpoint.
 */
export async function centroStatus(tenantId, { retry = false } = {}) {
  const { rows } = await query(
    `SELECT id, slug, ghl_location_id, ghl_token, ghl_calendar_id, ghl_user_id
       FROM tenants WHERE id = $1::uuid`,
    [tenantId],
  );
  const t = rows[0];
  if (!t?.ghl_token) return { linked: false, check: null, queue: {}, failed: [] };

  const check = await connectionFor(t);
  let retried = null;
  if (retry) {
    const requeued = await requeueFailed(t.id);
    // This salon's queue only: somebody pressing retry should not be the
    // one who waits on another tenant's backlog.
    const results = await drain(Math.max(10, requeued), { tenantId: t.id });
    retried = {
      requeued,
      sent: results.filter((r) => !r.error).length,
      stillFailing: results.filter((r) => r.error).length,
    };
  }

  const { rows: counts } = await query(
    `SELECT state, count(*)::int AS n FROM sync_outbox
      WHERE tenant_id = $1::uuid AND state <> 'done' GROUP BY state`,
    [t.id],
  );
  const { rows: failed } = await query(
    `SELECT o.id, o.kind, o.last_error, o.attempts, o.created_at,
            a.ref, a.guest_name, a.starts_at
       FROM sync_outbox o
       LEFT JOIN appointments a ON a.id = o.appointment_id
      WHERE o.tenant_id = $1::uuid AND o.state = 'failed'
      ORDER BY o.created_at DESC
      LIMIT 20`,
    [t.id],
  );
  return {
    linked: true,
    check,
    retried,
    queue: Object.fromEntries(counts.map((r) => [r.state, r.n])),
    failed: failed.map((f) => ({
      id: f.id,
      kind: f.kind,
      ref: f.ref,
      guestName: f.guest_name,
      startsAt: f.starts_at,
      error: f.last_error,
      attempts: f.attempts,
      at: f.created_at,
    })),
  };
}

export default handler({
  async GET(req, res) {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.authorization !== `Bearer ${secret}`) {
      return json(res, 401, { error: 'Unauthorized' });
    }

    // Before draining: if the link to CENTRO works again, whatever failed
    // while it did not goes back in the queue. Details go to the logs, not
    // the response, which is reachable by anyone when CRON_SECRET is unset.
    const { rows: tenants } = await query(
      `SELECT id, slug, ghl_location_id, ghl_token, ghl_calendar_id, ghl_user_id
         FROM tenants WHERE ghl_token IS NOT NULL`,
    );
    const linked = {};
    for (const t of tenants) {
      const check = await connectionFor(t);
      linked[t.slug] = check.ok;
      console.log(`CENTRO link for ${t.slug}:`, JSON.stringify(check));
      if (check.ok) {
        const n = await requeueFailed(t.id);
        if (n) console.log(`Requeued ${n} failed CENTRO job(s) for ${t.slug}.`);
      }
    }

    const processed = await drain();
    const { rows } = await query(
      `SELECT state, count(*)::int AS n FROM sync_outbox
        WHERE state <> 'done' GROUP BY state`,
    );
    return json(res, 200, {
      linked,
      processed: processed.length,
      // Counts only: results carry CENTRO ids and error text, and this
      // response is public when CRON_SECRET is unset.
      queue: Object.fromEntries(rows.map((r) => [r.state, r.n])),
    });
  },
});

// The pool is shared with the rest of the functions; nothing to close here.
export { pool };
