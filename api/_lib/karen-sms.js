/**
 * Karen by text (asked for 2026-10-22): the number clients text to book,
 * move or cancel an appointment, and the team texts to ask what is on their
 * schedule.
 *
 * Who is texting is read from the number they text from: a team member's
 * phone (staff_users.phone) first, then a client's (contacts.phone), matched
 * on the last ten digits so "(813) 555-0101" and "+18135550101" are the same
 * person. That is what lets Karen say "Hi Dina!" and answer "what's on my
 * schedule?" from the book. The number is only trusted because the webhook
 * checks the phone provider's signature before anything here runs.
 *
 * Like the chat in the console, Karen is not a language model: she
 * recognises what people say in a salon ("cancel", "can I move it", "what's
 * on tomorrow", "book a cut") and offers numbered choices, so a reply of "2"
 * always means something definite. Every change goes through the same rules
 * as the website and the guest's own manage page: the same free times
 * (availableSlots), the same database guarantee against double-booking, the
 * same emails and Google copies.
 *
 * Booking a new appointment by text follows ONLINE_BOOKING: while online
 * booking is paused, Karen says so and gives the salon's number. Moving and
 * cancelling an appointment that exists works either way, as on the manage
 * page.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { DateTime } from 'luxon';

import { availableSlots } from './availability.js';
import { createBooking } from './booking.js';
import { ONLINE_BOOKING } from './config.js';
import { EXCLUSION_VIOLATION, query, transaction } from './db.js';
import { sendCancellation, sendConfirmation, sendReschedule } from './email.js';
import { mirrorToGoogle } from './google-mirror.js';

/** A conversation left this long is a new one: "2" no longer means the old list. */
const THREAD_TTL_MIN = 30;
/** How far ahead Karen looks for times to offer. */
const OFFER_DAYS = 14;
/** One text's worth of choices. */
const OFFER_COUNT = 5;

/**
 * Run work in a transaction: the caller's own when it passes one already
 * open (a test, which rolls everything back), else a fresh one.
 */
const inTx = (db, fn) => (db.inTransaction ? fn(db) : transaction(fn));

/** The last ten digits: how two ways of writing one number become the same. */
export function phoneKey(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

export function prettyPhone(value) {
  const k = phoneKey(value);
  return k ? `(${k.slice(0, 3)}) ${k.slice(3, 6)}-${k.slice(6)}` : '';
}

/** The same number, wherever and however it was typed into the app. */
const SAME_PHONE = (column, param) => `right(regexp_replace(${column}, '\\D', '', 'g'), 10) = ${param}::text`;

/**
 * Is this request really from the phone provider? Twilio signs the exact URL
 * it called plus every posted field, sorted, with the account's auth token.
 * Without the token nothing is trusted: anyone could otherwise post a
 * client's number and read their appointments.
 */
export function twilioSignatureOk(url, params, signature, token) {
  if (!token || !signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const want = Buffer.from(createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64'));
  const got = Buffer.from(String(signature));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** The salon whose Karen number this text was sent to. */
export async function tenantIdForKarenNumber(to, db = { query }) {
  const key = phoneKey(to);
  if (!key) return null;
  const { rows } = await db.query(
    `SELECT id FROM tenants
      WHERE active AND ${SAME_PHONE("coalesce(to_jsonb(tenants) ->> 'karen_phone', '')", '$1')}
      LIMIT 1`,
    [key],
  );
  return rows[0]?.id ?? null;
}

/**
 * Who is texting: a team member (with their chair in the book, if they have
 * one), else a client, else nobody the salon knows yet.
 */
export async function whoIsTexting(db, tenantId, from) {
  const key = phoneKey(from);
  if (!key) return { kind: 'unknown' };
  const { rows: staff } = await db.query(
    `SELECT u.id, u.name, s.id AS stylist_id
       FROM staff_users u
       LEFT JOIN stylists s ON s.staff_user_id = u.id AND s.tenant_id = u.tenant_id
      WHERE u.tenant_id = $1::uuid AND u.status = 'active' AND u.phone <> ''
        AND ${SAME_PHONE('u.phone', '$2')}
      ORDER BY s.active DESC NULLS LAST
      LIMIT 1`,
    [tenantId, key],
  );
  if (staff[0]) return { kind: 'staff', ...staff[0] };
  const { rows: clients } = await db.query(
    `SELECT id, name, email, phone FROM contacts
      WHERE tenant_id = $1::uuid AND phone <> '' AND ${SAME_PHONE('phone', '$2')}
      ORDER BY updated_at DESC
      LIMIT 1`,
    [tenantId, key],
  );
  if (clients[0]) return { kind: 'client', ...clients[0] };
  return { kind: 'unknown' };
}

// ── what people say ──────────────────────────────────────────────────────

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const KINDS = {
  color: /colou?r|balayage|highlight|foil|toner|gloss|dye|roots?\b/,
  treatments: /treatment|keratin|olaplex|k18|bond|scalp|brazilian/,
  cuts: /\bcuts?\b|haircut|trim|bang/,
  styling: /styl|blow ?out|updo|bridal|special event|extension/,
};
const YES = /^(y|yes|yeah|yep|yup|sure|ok|okay|confirm|please do|do it|go ahead|correct)\b/;
const NO = /^(n|no|nope|nah|keep it|never ?mind|don'?t)\b/;
const first = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/** "today", "tomorrow", "friday", "this week": the days a message asks about, on the salon's clock. */
function daysAsked(t, zone) {
  const today = DateTime.now().setZone(zone).startOf('day');
  if (/\b(this|next) week\b|\bweek\b/.test(t)) {
    return { from: today, to: today.plus({ days: 7 }), label: 'the next 7 days', many: true };
  }
  if (/\btomorrow\b|\btmrw\b/.test(t)) return { from: today.plus({ days: 1 }), to: today.plus({ days: 2 }), label: 'tomorrow' };
  const wd = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d.slice(0, 3)}(${d.slice(3)})?\\b`).test(t));
  if (wd >= 0) {
    const ahead = (wd + 1 - today.weekday + 7) % 7;
    const day = today.plus({ days: ahead });
    return { from: day, to: day.plus({ days: 1 }), label: ahead === 0 ? 'today' : day.toFormat('cccc, LLL d') };
  }
  return { from: today, to: today.plus({ days: 1 }), label: 'today' };
}

const when = (iso, zone) => DateTime.fromJSDate(new Date(iso)).setZone(zone).toFormat("ccc, LLL d 'at' h:mm a");
const clock = (iso, zone) => DateTime.fromJSDate(new Date(iso)).setZone(zone).toFormat('h:mm a');

/** A visit of several services is one appointment; the full list is in its lines or notes. */
function serviceOf(a) {
  const lines = Array.isArray(a.lines) ? a.lines : null;
  if (lines?.length) return lines.map((l) => l.name).join(' + ');
  return (String(a.notes || '').match(/^Services: (.+)$/m) || [])[1] || a.service;
}

// ── the conversation ─────────────────────────────────────────────────────

async function loadThread(db, tenantId, key) {
  const { rows } = await db.query(
    `SELECT state, updated_at > now() - make_interval(mins => $3::int) AS fresh
       FROM karen_threads WHERE tenant_id = $1::uuid AND phone = $2::text`,
    [tenantId, key, THREAD_TTL_MIN],
  );
  return rows[0]?.fresh ? rows[0].state : null;
}

async function saveThread(db, tenantId, key, state) {
  await db.query(
    `INSERT INTO karen_threads (tenant_id, phone, state, updated_at)
     VALUES ($1::uuid, $2::text, $3::jsonb, now())
     ON CONFLICT (tenant_id, phone) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [tenantId, key, JSON.stringify(state || {})],
  );
}

/**
 * Karen's answer to one text. `tenant` is the salon's row (tenantForUser's
 * columns), `from` the sender's number, `text` what they wrote.
 */
/**
 * The carriers' own keywords, sent as a whole message. The phone provider
 * answers these itself (unsubscribe, help, resubscribe) and blocks texts to
 * a number that has opted out, so Karen stays quiet rather than talk over
 * it. "cancel" alone is one of them: it unsubscribes, which is why Karen
 * asks people to say "cancel my appointment" instead.
 */
const CARRIER_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout',
  'help', 'info', 'start', 'unstop']);
export const isCarrierKeyword = (text) => CARRIER_KEYWORDS.has(String(text || '').trim().toLowerCase().replace(/[^a-z]/g, ''));

export async function karenReply(tenant, from, text, db = { query }) {
  if (isCarrierKeyword(text)) return '';
  const key = phoneKey(from);
  const t = String(text || '').trim().toLowerCase().replace(/[’']/g, "'").slice(0, 400);
  const who = await whoIsTexting(db, tenant.id, from);
  const state = key ? await loadThread(db, tenant.id, key) : null;
  // A name the first time in a while: "Hi Dina!" once, not on every reply.
  const hello = state ? '' : who.name ? `Hi ${first(who.name)}! ` : "Hi! I'm Karen, the assistant at " + `${tenant.name}. `;
  const ctx = { tenant, who, key, t, raw: String(text || '').trim(), db };

  let out;
  try {
    out = await route(ctx, state || {});
  } catch (err) {
    console.error('karen-sms failed', err);
    out = { say: `Sorry, something went wrong on my end. Please call the salon${tenant.phone ? ` at ${prettyPhone(tenant.phone) || tenant.phone}` : ''}.`, state: {} };
  }
  if (key) await saveThread(db, tenant.id, key, out.state || {});
  // The first reply in a conversation says how to stop and get help, as the
  // salon's texting registration (A2P 10DLC) promises the carriers.
  return hello + out.say + (state ? '' : '\n\nReply STOP to opt out, HELP for help.');
}

async function route(ctx, state) {
  const { t, who } = ctx;
  if (/^(menu|help|start over|restart|hi|hey|hello|hiya|good (morning|afternoon|evening))\b[\s!.?]*$/.test(t)) {
    return menu(ctx);
  }
  // A reply to the question standing, if it is one.
  const step = STEPS[state.step];
  if (step) {
    const done = await step(ctx, state);
    if (done) return done;
  }
  if (who.kind === 'staff' && /\bcancel|reschedul|\bmove\b/.test(t)) {
    return { say: 'To move or cancel a client\'s appointment, open it on Appt. Book in the app. Here I can tell you what\'s on your schedule: try "today" or "tomorrow".', state: {} };
  }
  if (/\bcancel/.test(t)) return pickAppointment(ctx, 'cancel');
  if (/reschedul|\bmove\b|\bchange\b|different (time|day)|another (time|day)|push (it )?back|earlier|later/.test(t)) {
    return pickAppointment(ctx, 'move');
  }
  if (who.kind === 'staff' && /schedul|appointment|what'?s on|whats on|\bmy day\b|today|tomorrow|week|booked|clients?|calendar|\b(mon|tue|wed|thu|fri|sat|sun)/.test(t)) {
    return staffSchedule(ctx);
  }
  if (/\bbook\b|make an? appointment|schedule me|get me in|fit me in|opening|availab|free time|come in/.test(t)
      || Object.values(KINDS).some((re) => re.test(t))) {
    return startBooking(ctx);
  }
  if (/appointment|schedul|what'?s on|whats on|when is|upcoming|booked|calendar|today|tomorrow/.test(t)) {
    return myAppointments(ctx);
  }
  return menu(ctx, true);
}

function menu({ who }, unsure = false) {
  const lead = unsure ? "I didn't quite catch that. " : '';
  if (who.kind === 'staff') {
    return { say: `${lead}I can tell you what's on your schedule. Try "today", "tomorrow", "Friday" or "this week".`, state: {} };
  }
  return {
    say: `${lead}I can book an appointment, tell you when yours is, or move or cancel it. Just say "book", "my appointments", "reschedule" or "cancel my appointment".`,
    state: {},
  };
}

// ── the team: what's on the schedule ─────────────────────────────────────

async function staffSchedule({ tenant, who, t, db }) {
  const zone = tenant.timezone;
  const span = daysAsked(t, zone);
  const mine = Boolean(who.stylist_id);
  const { rows } = await db.query(
    `SELECT a.starts_at, a.guest_name, v.name AS service, s.name AS stylist, a.notes,
            to_jsonb(a) -> 'services' AS lines
       FROM appointments a
       JOIN services v ON v.id = a.service_id
       JOIN stylists s ON s.id = a.stylist_id
      WHERE a.tenant_id = $1::uuid AND a.status NOT IN ('cancelled')
        AND a.starts_at >= $2::timestamptz AND a.starts_at < $3::timestamptz
        AND ($4::uuid IS NULL OR a.stylist_id = $4::uuid)
      ORDER BY a.starts_at
      LIMIT 40`,
    [tenant.id, span.from.toISO(), span.to.toISO(), who.stylist_id || null],
  );
  // Somebody with no chair of their own (the owner, the front desk) asks
  // about the salon's day; a stylist about theirs.
  const whose = mine ? 'you have' : 'the salon has';
  if (!rows.length) {
    return { say: `Nothing booked ${span.label}${mine ? ' for you' : ''}. Enjoy the breathing room!`, state: {} };
  }
  const line = (r) => `${span.many ? DateTime.fromJSDate(new Date(r.starts_at)).setZone(zone).toFormat('ccc ') : ''}`
    + `${clock(r.starts_at, zone)} ${first(r.guest_name)}${r.guest_name.trim().includes(' ') ? ` ${r.guest_name.trim().split(/\s+/).pop()[0]}.` : ''}, ${serviceOf(r)}`
    + `${mine ? '' : ` (${first(r.stylist)})`}`;
  const shown = rows.slice(0, 8).map(line);
  const more = rows.length > shown.length ? `\n…and ${rows.length - shown.length} more.` : '';
  return {
    say: `${span.label[0].toUpperCase()}${span.label.slice(1)} ${whose} ${rows.length} appointment${rows.length === 1 ? '' : 's'}:\n${shown.join('\n')}${more}`,
    state: {},
  };
}

// ── clients: their appointments ──────────────────────────────────────────

async function upcoming({ tenant, who, db }) {
  if (who.kind !== 'client') return [];
  const { rows } = await db.query(
    `SELECT a.id, a.ref, a.starts_at, a.duration_min, a.buffer_min, a.breaks, a.notes,
            to_jsonb(a) -> 'services' AS lines,
            s.name AS stylist, s.slug AS stylist_slug, v.name AS service, v.slug AS service_slug
       FROM appointments a
       JOIN stylists s ON s.id = a.stylist_id
       JOIN services v ON v.id = a.service_id
      WHERE a.tenant_id = $1::uuid AND a.contact_id = $2::uuid
        AND a.status = 'booked' AND a.starts_at > now()
      ORDER BY a.starts_at
      LIMIT 5`,
    [tenant.id, who.id],
  );
  return rows;
}

const describe = (a, zone) => `${serviceOf(a)} with ${first(a.stylist)} on ${when(a.starts_at, zone)}`;

async function myAppointments(ctx) {
  const list = await upcoming(ctx);
  const zone = ctx.tenant.timezone;
  if (ctx.who.kind !== 'client') {
    return { say: "I don't have this number on file yet, so I can't see any appointments for it. Text \"book\" to make one, or call the salon.", state: {} };
  }
  if (!list.length) return { say: 'You have no upcoming appointments. Text "book" to make one!', state: {} };
  return {
    say: `Here's what you have coming up:\n${list.map((a) => `• ${describe(a, zone)}`).join('\n')}\nText "reschedule" or "cancel my appointment" to change one.`,
    state: {},
  };
}

/** Which appointment to cancel or move: straight on when there is one, a numbered list when there are several. */
async function pickAppointment(ctx, purpose) {
  const list = await upcoming(ctx);
  const zone = ctx.tenant.timezone;
  if (ctx.who.kind !== 'client') {
    return { say: "I don't have this number on file, so I can't find an appointment for it. Please call the salon and they'll sort it out.", state: {} };
  }
  if (!list.length) return { say: "I don't see any upcoming appointments for you, so there's nothing to change.", state: {} };
  // "Move my haircut": when what they said names just one of them, that one.
  const named = list.length > 1 ? list.filter((a) => mentions(ctx.t, a)) : [];
  const one = list.length === 1 ? list[0] : named.length === 1 ? named[0] : null;
  if (one) return purpose === 'cancel' ? askCancel(one, zone) : offerMove(ctx, one);
  return {
    say: `Which appointment would you like to ${purpose === 'cancel' ? 'cancel' : 'move'}?\n`
      + `${list.map((a, i) => `${i + 1}. ${describe(a, zone)}`).join('\n')}\nReply with its number.`,
    state: { step: 'pick', purpose, ids: list.map((a) => a.id) },
  };
}

/** Does the message name this appointment's service, or its kind ("the haircut", "my color")? */
function mentions(t, a) {
  const name = serviceOf(a).toLowerCase();
  if (name.split(/[^a-z']+/).some((w) => w.length > 3 && t.includes(w.replace(/'s$/, '')))) return true;
  return Object.values(KINDS).some((re) => re.test(t) && re.test(name));
}

function askCancel(a, zone) {
  return {
    say: `Cancel your ${describe(a, zone)}? Reply YES to cancel, or NO to keep it.`,
    state: { step: 'cancelYes', id: a.id },
  };
}

/** Times on the same stylist, at the appointment's own length: what the manage page would offer. */
async function offerMove(ctx, a, day = null) {
  const { tenant } = ctx;
  const zone = tenant.timezone;
  const today = DateTime.now().setZone(zone).startOf('day');
  const from = day || today;
  const to = day || today.plus({ days: OFFER_DAYS - 1 });
  const offers = await inTx(ctx.db, async (client) => {
    try {
      const { days } = await availableSlots(client, tenant, {
        serviceSlug: a.service_slug,
        stylistSlug: a.stylist_slug,
        fromDate: from.toISODate(),
        toDate: to.toISODate(),
        excludeAppointmentId: a.id,
        google: true,
        length: { durationMin: a.duration_min, bufferMin: a.buffer_min, breaks: a.breaks },
      });
      return spread(days, day ? OFFER_COUNT : 2);
    } catch (err) {
      if (err.status === 404) return [];
      throw err;
    }
  });
  if (!offers.length) {
    return {
      say: day ? `${first(a.stylist)} has nothing free ${day.toFormat('cccc, LLL d')}. Try another day, or reply MORE for the next openings.`
        : `${first(a.stylist)} has no openings in the next two weeks. Please call the salon and they'll find you a time.`,
      state: day ? { step: 'moveTimes', id: a.id, offers: [] } : {},
    };
  }
  return {
    say: `Your ${serviceOf(a)} with ${first(a.stylist)} is ${when(a.starts_at, zone)}. Here are the next openings:\n`
      + `${offers.map((s, i) => `${i + 1}. ${when(s, zone)}`).join('\n')}\nReply with a number, or a day like "Friday".`,
    state: { step: 'moveTimes', id: a.id, offers },
  };
}

/** A few times worth choosing from: at most `perDay` a day, so the list reaches across the week. */
function spread(days, perDay) {
  const out = [];
  for (const d of days) {
    const slots = d.slots || [];
    const picks = perDay >= slots.length ? slots
      : [slots[0], ...(perDay > 1 ? [slots[Math.floor(slots.length / 2)]] : [])].slice(0, perDay);
    for (const s of picks) if (out.length < OFFER_COUNT && !out.includes(s.start)) out.push(s.start);
    if (out.length >= OFFER_COUNT) break;
  }
  return out;
}

async function appointmentById(ctx, id) {
  return (await upcoming(ctx)).find((a) => a.id === id) || null;
}

async function cancelIt(ctx, a) {
  const { tenant } = ctx;
  const appt = await inTx(ctx.db, async (client) => {
    const { rows } = await client.query(
      `UPDATE appointments SET status = 'cancelled', cancelled_at = now(), updated_at = now()
        WHERE id = $1::uuid AND tenant_id = $2::uuid AND status = 'booked' AND starts_at > now()
        RETURNING *`,
      [a.id, tenant.id],
    );
    return rows[0] ? { ...rows[0], stylist_name: a.stylist, stylist_slug: a.stylist_slug, service_name: a.service, service_slug: a.service_slug } : null;
  });
  if (!appt) return { say: 'That appointment has already been changed. Text "my appointments" to see where things stand.', state: {} };
  await afterChange(appt, () => sendCancellation(appt, tenant));
  return { say: `Done: your ${describe(a, tenant.timezone)} is cancelled. Text "book" whenever you'd like to come back in.`, state: {} };
}

async function moveIt(ctx, a, start) {
  const { tenant } = ctx;
  const zone = tenant.timezone;
  const startsAt = DateTime.fromISO(start, { setZone: true }).setZone(zone);
  let appt;
  try {
    appt = await inTx(ctx.db, async (client) => {
      // The time again, fresh: it was offered minutes ago and somebody may
      // have taken it since.
      const { days } = await availableSlots(client, tenant, {
        serviceSlug: a.service_slug,
        stylistSlug: a.stylist_slug,
        fromDate: startsAt.toISODate(),
        toDate: startsAt.toISODate(),
        excludeAppointmentId: a.id,
        google: true,
        length: { durationMin: a.duration_min, bufferMin: a.buffer_min, breaks: a.breaks },
      });
      const slot = days.flatMap((d) => d.slots).find((s) => DateTime.fromISO(s.start).toMillis() === startsAt.toMillis());
      if (!slot) return null;
      const { rows } = await client.query(
        `UPDATE appointments
            SET starts_at = $2::timestamptz, stylist_id = $3::uuid,
                during = tstzrange($2::timestamptz,
                                   $2::timestamptz + make_interval(mins => duration_min + buffer_min), '[)'),
                updated_at = now()
          WHERE id = $1::uuid AND status = 'booked'
          RETURNING *`,
        [a.id, startsAt.toISO(), slot.stylistIds[0]],
      );
      return rows[0] ? { ...rows[0], stylist_name: a.stylist, stylist_slug: a.stylist_slug, service_name: a.service, service_slug: a.service_slug } : null;
    });
  } catch (err) {
    if (err.code !== EXCLUSION_VIOLATION) throw err;
    appt = null;
  }
  if (!appt) {
    const again = await offerMove(ctx, a);
    return { say: `Sorry, that time was just taken. ${again.say}`, state: again.state };
  }
  await afterChange(appt, () => sendReschedule(appt, a.starts_at, tenant));
  return { say: `All set! Your ${serviceOf(a)} with ${first(a.stylist)} is now ${when(appt.starts_at, zone)}. See you then!`, state: {} };
}

/** The change is committed; the email and the Google copy are courtesies on top. */
async function afterChange(appt, email) {
  try { await email(); } catch (err) { console.error('karen-sms email failed for', appt.ref, err); }
  await mirrorToGoogle().catch((err) => console.error('google mirror deferred for', appt.ref, err));
}

// ── clients: a new booking ───────────────────────────────────────────────

async function startBooking(ctx) {
  const { tenant, t, db } = ctx;
  if (ctx.who.kind === 'staff') {
    return { say: 'To book a client, use New appointment in the app. I can tell you what\'s on your schedule here: try "today" or "tomorrow".', state: {} };
  }
  if (!ONLINE_BOOKING) {
    return {
      say: `Booking by text opens soon! For now, please call the salon${tenant.phone ? ` at ${prettyPhone(tenant.phone) || tenant.phone}` : ''} and they'll get you in.`,
      state: {},
    };
  }
  const { rows: services } = await db.query(
    `SELECT slug, name, category FROM services
      WHERE tenant_id = $1::uuid AND active ORDER BY category, name`,
    [tenant.id],
  );
  const named = services.find((s) => t.includes(s.name.toLowerCase()));
  if (named) return offerBook(ctx, named);
  const kind = Object.keys(KINDS).find((k) => KINDS[k].test(t));
  const choices = kind ? services.filter((s) => s.category === kind) : [];
  if (choices.length === 1) return offerBook(ctx, choices[0]);
  if (choices.length) {
    const list = choices.slice(0, 8);
    return {
      say: `Lovely! Which one?\n${list.map((s, i) => `${i + 1}. ${s.name}`).join('\n')}\nReply with its number.`,
      state: { step: 'bookService', options: list },
    };
  }
  return {
    say: 'Happy to book you in! What would you like: a color, a cut, a treatment or styling?',
    state: { step: 'bookKind' },
  };
}

async function offerBook(ctx, service, day = null) {
  const { tenant } = ctx;
  const zone = tenant.timezone;
  const today = DateTime.now().setZone(zone).startOf('day');
  const offers = await inTx(ctx.db, async (client) => {
    try {
      const { days } = await availableSlots(client, tenant, {
        serviceSlug: service.slug,
        fromDate: (day || today).toISODate(),
        toDate: (day || today.plus({ days: OFFER_DAYS - 1 })).toISODate(),
        google: true,
      });
      return spread(days, day ? OFFER_COUNT : 2);
    } catch (err) {
      if (err.status === 404) return [];
      throw err;
    }
  });
  if (!offers.length) {
    return {
      say: day ? `Nothing is free for ${service.name} ${day.toFormat('cccc, LLL d')}. Try another day?`
        : `There are no online openings for ${service.name} in the next two weeks. Please call the salon and they'll find you a time.`,
      state: day ? { step: 'bookTimes', service, offers: [] } : {},
    };
  }
  return {
    say: `Here are the next openings for ${service.name}:\n${offers.map((s, i) => `${i + 1}. ${when(s, zone)}`).join('\n')}\nReply with a number, or a day like "Saturday".`,
    state: { step: 'bookTimes', service, offers },
  };
}

async function bookIt(ctx, service, start, name) {
  const { tenant, who, key } = ctx;
  let appt;
  try {
    appt = await inTx(ctx.db, (client) => createBooking(client, tenant, {
      serviceSlug: service.slug,
      stylistSlug: null,
      start,
      guestName: name,
      guestEmail: who.email || '',
      guestPhone: prettyPhone(key) || '',
      contactId: who.kind === 'client' ? who.id : null,
      notes: 'Booked by text with Karen.',
      channel: 'online',
    }));
  } catch (err) {
    if (err.status !== 409) throw err;
    const again = await offerBook(ctx, service);
    return { say: `Sorry, that time was just taken. ${again.say}`, state: again.state };
  }
  if (appt.guest_email) {
    try { await sendConfirmation(appt, tenant); } catch (err) { console.error('karen-sms confirmation failed for', appt.ref, err); }
  }
  await mirrorToGoogle().catch((err) => console.error('google mirror deferred for', appt.ref, err));
  return {
    say: `You're booked, ${first(name)}! ${service.name} with ${first(appt.stylist_name)} on ${when(appt.starts_at, tenant.timezone)}. `
      + `Your reference is ${appt.ref}. Text me any time to move or cancel it.`,
    state: {},
  };
}

// ── answers to the question standing ─────────────────────────────────────

const number = (t) => { const m = t.match(/^\s*#?(\d{1,2})\b/); return m ? Number(m[1]) : null; };

const STEPS = {
  async pick(ctx, st) {
    const n = number(ctx.t);
    if (!n) {
      // Something else entirely ("book", "my appointments") goes on; anything
      // else ("yes", "the first one?") is asked again, not misunderstood.
      if (/cancel|reschedul|\bmove\b|\bbook\b|appointment|schedul|menu|help/.test(ctx.t)) return null;
      return { say: `Please reply with the number of the appointment, from 1 to ${st.ids.length}.`, state: st };
    }
    const a = st.ids[n - 1] && await appointmentById(ctx, st.ids[n - 1]);
    if (!a) return { say: `Please reply with a number from 1 to ${st.ids.length}.`, state: st };
    return st.purpose === 'cancel' ? askCancel(a, ctx.tenant.timezone) : offerMove(ctx, a);
  },

  async cancelYes(ctx, st) {
    const a = await appointmentById(ctx, st.id);
    if (!a) return { say: 'That appointment has already been changed. Text "my appointments" to see where things stand.', state: {} };
    if (YES.test(ctx.t)) return cancelIt(ctx, a);
    if (NO.test(ctx.t)) return { say: `No problem, your ${describe(a, ctx.tenant.timezone)} stays as it is.`, state: {} };
    return null;
  },

  async moveTimes(ctx, st) {
    const a = await appointmentById(ctx, st.id);
    if (!a) return null;
    const n = number(ctx.t);
    if (n && st.offers[n - 1]) return moveIt(ctx, a, st.offers[n - 1]);
    if (n) return { say: `Please reply with a number from 1 to ${st.offers.length}, or a day like "Friday".`, state: st };
    if (/\bmore\b|other|next/.test(ctx.t)) return offerMove(ctx, a);
    if (/\b(mon|tue|wed|thu|fri|sat|sun)|tomorrow|today/.test(ctx.t)) return offerMove(ctx, a, daysAsked(ctx.t, ctx.tenant.timezone).from);
    if (NO.test(ctx.t)) return { say: 'No problem, your appointment stays as it is.', state: {} };
    return null;
  },

  async bookKind(ctx) {
    if (!Object.values(KINDS).some((re) => re.test(ctx.t))) return null;
    return startBooking(ctx);
  },

  async bookService(ctx, st) {
    const n = number(ctx.t);
    const s = n ? st.options[n - 1] : st.options.find((x) => ctx.t.includes(x.name.toLowerCase()));
    if (!s) return n ? { say: `Please reply with a number from 1 to ${st.options.length}.`, state: st } : null;
    return offerBook(ctx, s);
  },

  async bookTimes(ctx, st) {
    const n = number(ctx.t);
    if (n && st.offers[n - 1]) {
      const start = st.offers[n - 1];
      if (ctx.who.kind === 'client') return bookIt(ctx, st.service, start, ctx.who.name);
      return { say: 'Great choice! And what name should I put the appointment under?', state: { step: 'bookName', service: st.service, start } };
    }
    if (n) return { say: `Please reply with a number from 1 to ${st.offers.length}, or a day like "Saturday".`, state: st };
    if (/\bmore\b|other|next/.test(ctx.t)) return offerBook(ctx, st.service);
    if (/\b(mon|tue|wed|thu|fri|sat|sun)|tomorrow|today/.test(ctx.t)) return offerBook(ctx, st.service, daysAsked(ctx.t, ctx.tenant.timezone).from);
    return null;
  },

  async bookName(ctx, st) {
    const name = ctx.raw.replace(/^((it'?s|its|it is|my name is|name is|this is|i'?m)\s+)+/i, '').trim().slice(0, 120);
    if (name.length < 2 || /\?$/.test(name)) return { say: 'What name should I put the appointment under?', state: st };
    return bookIt(ctx, st.service, st.start, name);
  },
};

// ── what Karen sends on her own ──────────────────────────────────────────

/**
 * The text that goes with a message kind, in Karen's voice and short enough
 * for one or two texts. Shown in Marketing's message preview; replies to it
 * land with Karen, which is why it invites them. Kinds with no text return
 * null. Nothing sends these yet: texts go out once a sending number is
 * connected.
 */
export function smsText(kind, appt, tenant) {
  const zone = tenant.timezone;
  const at = when(appt.starts_at, zone);
  const name = first(appt.guest_name) || 'there';
  const visit = `${appt.service_name} with ${first(appt.stylist_name)}`;
  const shop = tenant.name || 'the salon';
  const texts = {
    // Kept to one text (160 characters) for a usual name and service.
    confirmation: `Hi ${name}! You're booked at ${shop}: ${visit}, ${at}. Reply here to move or cancel. See you soon! - Karen`,
  };
  return texts[kind] || null;
}

