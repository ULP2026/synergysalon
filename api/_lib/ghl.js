/**
 * A thin client for the CENTRO / GoHighLevel v2 API.
 *
 * Only the calls the mirror needs. This is deliberately not a general
 * wrapper: every endpoint added here is another thing that can fail during a
 * booking, and the whole point of the outbox is that CENTRO is downstream.
 *
 * The salon's diary lives in Postgres. Everything here is a push of something
 * that has already happened, which is why appointments are created with
 * GoHighLevel's own slot validation switched off: if we asked it to agree that
 * a slot was free, a calendar configured differently from ours would start
 * rejecting appointments the salon has already taken.
 */
const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

class GhlError extends Error {
  constructor(status, body, path) {
    super(`GoHighLevel ${path} returned ${status}: ${String(body).slice(0, 300)}`);
    this.status = status;
    /** 4xx other than 429 will fail the same way next time; do not keep retrying. */
    this.permanent = status >= 400 && status < 500 && status !== 429;
  }
}

async function call(tenant, method, path, body) {
  if (!tenant.ghl_token || !tenant.ghl_location_id) {
    throw new GhlError(400, 'tenant has no CENTRO credentials', path);
  }

  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${tenant.ghl_token}`,
      Version: VERSION,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });

  const text = await res.text();
  if (!res.ok) throw new GhlError(res.status, text, path);
  return text ? JSON.parse(text) : {};
}

/**
 * An address GoHighLevel will accept, or nothing.
 *
 * It answers a malformed address with a 422, which this client classes as
 * permanent — correctly, since resending it changes nothing. The cost was that
 * one bad email killed the appointment attached to it for good: the push needs
 * a contact, the contact would not upsert, and the booking never reached the
 * calendar. A guest is better mirrored by phone alone than not at all.
 */
function usableEmail(value) {
  const s = String(value || '').trim();
  return /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(s) ? s : '';
}

/** GoHighLevel wants the name split; people give us one string. */
function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  return {
    firstName: parts[0] || 'Guest',
    lastName: parts.slice(1).join(' ') || '',
  };
}

/**
 * Create or find the contact.
 *
 * Upsert rather than create: the sub-account treats email and phone as unique
 * identifiers, so a returning guest must update their existing record instead
 * of spawning a duplicate that splits their history in two.
 */
export async function upsertContact(tenant, { name, email, phone, source, tags = [] }) {
  const sendable = usableEmail(email);
  if (!sendable && !phone) {
    throw new GhlError(400, 'contact has neither a usable email nor a phone', '/contacts/upsert');
  }
  const data = await call(tenant, 'POST', '/contacts/upsert', {
    locationId: tenant.ghl_location_id,
    ...splitName(name),
    name: name || undefined,
    email: sendable || undefined,
    phone: phone || undefined,
    source: source || 'synergysalon.com',
    tags,
  });
  const id = data?.contact?.id ?? data?.id;
  if (!id) throw new GhlError(502, 'upsert returned no contact id', '/contacts/upsert');
  return id;
}

/**
 * Update a contact we already know the id of.
 *
 * Upsert matches on email or phone, so editing either of those would create a
 * second CENTRO contact and leave the salon with the person twice. Once the id
 * is known, the id is what should be used.
 */
export function updateContact(tenant, contactId, { name, email, phone }) {
  const parts = String(name || '').trim().split(/\s+/);
  return call(tenant, 'PUT', `/contacts/${contactId}`, {
    firstName: parts[0] || undefined,
    lastName: parts.slice(1).join(' ') || undefined,
    name: name || undefined,
    email: usableEmail(email) || undefined,
    phone: phone || undefined,
  });
}

export async function createAppointment(tenant, {
  contactId, startsAt, endsAt, title, notes, calendarId, assignedUserId,
}) {
  const data = await call(tenant, 'POST', '/calendars/events/appointments', {
    calendarId: calendarId || tenant.ghl_calendar_id,
    locationId: tenant.ghl_location_id,
    contactId,
    // Required, and the error when it is missing says only "a team member
    // needs to be selected": CENTRO's calendars are service_booking type and
    // refuse an unassigned event.
    assignedUserId,
    startTime: startsAt,
    endTime: endsAt,
    title,
    meetingLocationType: 'default',
    appointmentStatus: 'confirmed',
    // Our database already decided this slot is free and has stored the
    // appointment. Letting GoHighLevel re-adjudicate it here would mean a
    // calendar whose hours differ from ours silently drops real bookings.
    ignoreDateRange: true,
    ignoreFreeSlotValidation: true,
    // The guest already has our confirmation email. A second one from CENTRO
    // saying something slightly different is worse than none.
    toNotify: false,
    notes: notes || undefined,
  });
  const id = data?.id ?? data?.event?.id ?? data?.appointment?.id;
  if (!id) throw new GhlError(502, 'create returned no appointment id', '/calendars/events/appointments');
  return id;
}

export function updateAppointment(tenant, eventId, { startsAt, endsAt, title }) {
  return call(tenant, 'PUT', `/calendars/events/appointments/${eventId}`, {
    calendarId: tenant.ghl_calendar_id,
    startTime: startsAt,
    endTime: endsAt,
    title,
    ignoreDateRange: true,
    ignoreFreeSlotValidation: true,
    toNotify: false,
  });
}

/**
 * Marked cancelled rather than deleted, so the salon keeps the history and
 * any CENTRO automation watching for cancellations still fires.
 */
export function cancelAppointment(tenant, eventId) {
  return call(tenant, 'PUT', `/calendars/events/appointments/${eventId}`, {
    appointmentStatus: 'cancelled',
    toNotify: false,
  });
}

/**
 * Remove a contact the salon has deleted.
 *
 * A 404 counts as done: the contact is gone either way, whether somebody
 * removed it in CENTRO first or an earlier attempt succeeded and the reply was
 * lost. Treating it as a failure would leave a job that can never succeed.
 */
export async function deleteContact(tenant, contactId) {
  try {
    await call(tenant, 'DELETE', `/contacts/${contactId}`);
  } catch (err) {
    if (!(err instanceof GhlError && err.status === 404)) throw err;
  }
}

/**
 * Remove an event outright, rather than marking it cancelled.
 *
 * Cancelling is right when a guest cancels: the salon keeps the history and
 * CENTRO's automations fire. Deleting is for a booking that should never have
 * existed -- a test, a duplicate -- where leaving a cancelled ghost on the
 * calendar is just clutter the front desk has to read past.
 *
 * A 404 counts as done, for the same reason it does when deleting a contact.
 */
export async function deleteAppointment(tenant, eventId) {
  try {
    await call(tenant, 'DELETE', `/calendars/events/${eventId}`);
  } catch (err) {
    if (!(err instanceof GhlError && err.status === 404)) throw err;
  }
}

export { GhlError };
