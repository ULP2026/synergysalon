/**
 * The website survey (/api/enquiry) may only change what its own session
 * made.
 *
 * It is called on every keystroke and matches a guest to an existing client
 * by email or phone, so a guest who has booked before keeps one record. But
 * a match by email or phone alone is not proof that it is the same person:
 * anybody can type a client's address. So only the survey session that
 * booked an appointment may move it, only the session a contact was created
 * in may change that contact's details, and the reply only ever describes an
 * appointment this session made. Driven through the real handler, as the
 * page calls it. Rows are named ZZG and removed before and after.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';

import { createBooking } from '../api/_lib/booking.js';
import { pool, transaction } from '../api/_lib/db.js';
import enquiry from '../api/enquiry.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

function call(body) {
  return new Promise((resolve) => {
    const out = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }); },
    };
    enquiry({
      method: 'POST', url: '/api/enquiry?salon=synergy',
      headers: { host: 'localhost', origin: 'http://localhost' }, body,
    }, out);
  });
}

/**
 * A Thursday ten weeks out, inside the 90-day booking horizon and clear of
 * the weeks the other integration files book into. Kim works Thursdays 9 to
 * 7 in the seed; times are kept away from the flexible lunch (11 to 1).
 */
function thursday(zone) {
  let d = DateTime.now().setZone(zone).plus({ days: 70 }).startOf('day');
  while (d.weekday !== 4) d = d.plus({ days: 1 });
  return d;
}

const survey = (day, {
  sessionId, name, email = '', phone = '', hour, minute = 0, stylistSlug = 'kim', notes = '',
}) => {
  const at = day.set({ hour, minute });
  const body = {
    name, email, phone, notes,
    serviceLabel: "Women's cut", services: ["Women's cut"], stylistSlug,
    month: at.toFormat('LLLL yyyy'), day: String(at.day), time: at.toFormat('h:mm a'),
  };
  if (sessionId) body.sessionId = sessionId;
  return call(body);
};

async function cleanup(db) {
  const ids = `(SELECT id FROM contacts WHERE name LIKE 'ZZG %' OR email LIKE 'zz-guard-%')`;
  await db.query(`DELETE FROM appointments WHERE contact_id IN ${ids} OR guest_email LIKE 'zz-guard-%' OR guest_name LIKE 'ZZG %' OR ref LIKE 'ZZG%'`);
  await db.query(`DELETE FROM message_sends WHERE contact_id IN ${ids}`);
  await db.query(`DELETE FROM contacts WHERE id IN ${ids}`);
}

async function setup() {
  const db = pool();
  await cleanup(db);
  const { rows: [tenant] } = await db.query("SELECT * FROM tenants WHERE slug = 'synergy'");
  return { db, tenant, day: thursday(tenant.timezone) };
}

const contactRow = async (db, id) => (await db.query(
  'SELECT name, email, phone, notes, source, session_id FROM contacts WHERE id = $1::uuid', [id],
)).rows[0];

const apptRow = async (db, ref) => (await db.query(
  `SELECT a.id, a.ref, a.starts_at, a.stylist_id, a.contact_id, a.status, s.name AS stylist_name,
          to_jsonb(a) ->> 'booked_session_id' AS booked_session_id
     FROM appointments a JOIN stylists s ON s.id = a.stylist_id WHERE a.ref = $1::text`, [ref],
)).rows[0];

const bookedFor = async (db, contactId) => (await db.query(
  `SELECT ref, starts_at FROM appointments
    WHERE contact_id = $1::uuid AND status = 'booked' ORDER BY starts_at`, [contactId],
)).rows;

/** Nothing about `appt` is in the reply: not its ref, stylist, time or calendar entry. */
function assertSaysNothingOf(reply, appt) {
  const text = JSON.stringify(reply);
  assert.ok(!text.includes(appt.ref), 'the reply does not carry their ref');
  const at = DateTime.fromJSDate(new Date(appt.starts_at)).toUTC();
  assert.notEqual(reply.startsAt && new Date(reply.startsAt).getTime(), at.toMillis(),
    'the reply does not carry their time');
  assert.ok(!text.includes(at.toFormat("yyyyLLdd'T'HHmmss'Z'")), 'nor their calendar entry');
  if (reply.stylist) assert.notEqual(reply.stylist, appt.stylist_name, 'nor their stylist');
}

test('one guest in one session books once and moves their own appointment', { skip }, async () => {
  const { db, day } = await setup();
  try {
    const sessionId = 'zzguard-session-one';
    const guest = { sessionId, name: 'ZZG Guest One', phone: '8135550181', hour: 9 };

    // The name alone: nothing to reach them on yet.
    const early = await survey(day, { ...guest, phone: '' });
    assert.equal(early.body.saved, false);

    // The number and half an address: saved, and the booking waits.
    const waiting = await survey(day, { ...guest, email: 'zz-guard-one@exa' });
    assert.equal(waiting.body.saved, true);
    assert.equal(waiting.body.ref, null);

    // The whole address: booked.
    const first = await survey(day, { ...guest, email: 'zz-guard-one@example.com' });
    assert.equal(first.status, 200);
    assert.ok(first.body.ref, `booked as soon as there is enough to book with: ${JSON.stringify(first.body)}`);
    const made = await apptRow(db, first.body.ref);
    assert.equal(made.booked_session_id, sessionId, 'the booking knows which session made it');

    // More keystrokes: the same booking, with its details in the reply.
    const typed = await survey(day, { ...guest, email: 'zz-guard-one@example.com', notes: 'fringe' });
    assert.equal(typed.body.ref, first.body.ref);
    assert.equal(typed.body.stylist, made.stylist_name);
    assert.ok(typed.body.calendar, 'the calendar link comes back for their own booking');

    // They change their mind about the time: their booking moves.
    const moved = await survey(day, { ...guest, email: 'zz-guard-one@example.com', hour: 10 });
    assert.equal(moved.body.ref, first.body.ref, 'moved, not booked twice');
    assert.equal(new Date(moved.body.startsAt).getTime(), day.set({ hour: 10 }).toMillis());

    const rows = await bookedFor(db, made.contact_id);
    assert.equal(rows.length, 1, 'one guest, one appointment');
    assert.equal(new Date(rows[0].starts_at).getTime(), day.set({ hour: 10 }).toMillis());

    const contact = await contactRow(db, made.contact_id);
    assert.equal(contact.email, 'zz-guard-one@example.com', 'their own session fills their details in');
    assert.match(contact.notes, /fringe|Women's cut/);
    assert.equal(contact.session_id, sessionId);
  } finally {
    await cleanup(db);
  }
});

test("another session typing a client's email changes nothing of theirs", { skip }, async () => {
  const { db, day } = await setup();
  try {
    // The client, booked online in their own session.
    const client = {
      sessionId: 'zzguard-client-two', name: 'ZZG Client Two',
      email: 'zz-guard-two@example.com', phone: '8135550182', hour: 14, notes: 'original note',
    };
    const booked = await survey(day, client);
    assert.ok(booked.body.ref);
    const theirs = await apptRow(db, booked.body.ref);
    const before = await contactRow(db, theirs.contact_id);

    // Somebody else, in another session, types the client's email, a new
    // name, number and note, and a time.
    const other = {
      sessionId: 'zzguard-other-two', name: 'ZZG Somebody Else',
      email: 'zz-guard-two@example.com', phone: '8135550189', hour: 16, stylistSlug: 'dina',
      notes: 'changed note',
    };
    const reply = await survey(day, other);
    assert.equal(reply.status, 200);

    assert.deepEqual(await contactRow(db, theirs.contact_id), before,
      "the client's name, phone, notes and session are as they were");
    const after = await apptRow(db, theirs.ref);
    assert.equal(new Date(after.starts_at).getTime(), new Date(theirs.starts_at).getTime(),
      'their appointment has not moved');
    assert.equal(after.stylist_id, theirs.stylist_id, 'nor changed stylist');
    assert.equal(after.status, 'booked');
    assertSaysNothingOf(reply.body, theirs);

    // That session's own booking is made, for the client's record...
    assert.ok(reply.body.ref, 'the other session books its own appointment');
    const own = await apptRow(db, reply.body.ref);
    assert.equal(own.contact_id, theirs.contact_id, "linked to the client's contact");
    assert.equal(own.booked_session_id, other.sessionId);

    // ...and its later saves move only that one.
    const again = await survey(day, { ...other, hour: 17 });
    assert.equal(again.body.ref, own.ref, 'its own booking, moved');
    assert.equal(new Date((await apptRow(db, own.ref)).starts_at).getTime(), day.set({ hour: 17 }).toMillis());
    assert.equal(new Date((await apptRow(db, theirs.ref)).starts_at).getTime(),
      new Date(theirs.starts_at).getTime(), "the client's still has not moved");
    assertSaysNothingOf(again.body, theirs);
    assert.deepEqual(await contactRow(db, theirs.contact_id), before);
  } finally {
    await cleanup(db);
  }
});

test("another session typing a client's phone changes nothing of theirs", { skip }, async () => {
  const { db, tenant, day } = await setup();
  try {
    // The client, booked at the front desk: no survey session at all.
    const desk = await transaction((c) => createBooking(c, tenant, {
      serviceSlug: 'womens-cut', stylistSlug: 'kim', start: day.set({ hour: 15 }).toISO(),
      guestName: 'ZZG Client Three', guestEmail: 'zz-guard-three@example.com',
      guestPhone: '8135550183', channel: 'staff', minLeadMin: 0,
    }));
    const theirs = await apptRow(db, desk.ref);
    const before = await contactRow(db, theirs.contact_id);

    // Another session types the client's number (with an address of its
    // own, which matches nobody), and picks the very time the client
    // already has: told nothing about it.
    const other = {
      sessionId: 'zzguard-other-three', name: 'ZZG Somebody Else',
      email: 'zz-guard-other-three@example.com', phone: '8135550183', hour: 15, notes: 'changed note',
    };
    const same = await survey(day, other);
    assert.equal(same.status, 200);
    assertSaysNothingOf(same.body, theirs);
    assert.equal(same.body.ref, null, 'no appointment of theirs is named');
    assert.equal((await bookedFor(db, theirs.contact_id)).length, 1, 'and none is booked on top of it');

    // At another time it books its own, and moves nothing of the client's.
    const reply = await survey(day, { ...other, hour: 9, stylistSlug: 'dina' });
    assert.ok(reply.body.ref);
    assertSaysNothingOf(reply.body, theirs);
    const own = await apptRow(db, reply.body.ref);
    assert.equal(own.contact_id, theirs.contact_id);
    assert.equal(own.booked_session_id, other.sessionId);

    const after = await apptRow(db, theirs.ref);
    assert.equal(new Date(after.starts_at).getTime(), new Date(theirs.starts_at).getTime());
    assert.equal(after.stylist_id, theirs.stylist_id);
    assert.deepEqual(await contactRow(db, theirs.contact_id), before,
      "the client's name, phone, notes and session are as they were");
  } finally {
    await cleanup(db);
  }
});

test('with no session, a matched client is neither renamed nor moved', { skip }, async () => {
  const { db, day } = await setup();
  try {
    const booked = await survey(day, {
      sessionId: 'zzguard-client-four', name: 'ZZG Client Four',
      email: 'zz-guard-four@example.com', phone: '8135550184', hour: 14, notes: 'original note',
    });
    const theirs = await apptRow(db, booked.body.ref);
    const before = await contactRow(db, theirs.contact_id);

    const anon = {
      name: 'ZZG Nobody', email: 'zz-guard-four@example.com', phone: '8135550188', notes: 'changed',
    };

    // At the client's own time: nothing booked on top, nothing said of it.
    const same = await survey(day, { ...anon, hour: 14 });
    assert.equal(same.status, 200);
    assert.equal(same.body.ref, null);
    assertSaysNothingOf(same.body, theirs);
    assert.equal((await bookedFor(db, theirs.contact_id)).length, 1);

    // At another time: a booking of its own, as before, and the client's stays.
    const other = await survey(day, { ...anon, hour: 9, stylistSlug: 'dina' });
    assertSaysNothingOf(other.body, theirs);
    const after = await apptRow(db, theirs.ref);
    assert.equal(new Date(after.starts_at).getTime(), new Date(theirs.starts_at).getTime());
    assert.equal(after.stylist_id, theirs.stylist_id);

    // Sent again, the same: not a second booking at that time.
    const count = (await bookedFor(db, theirs.contact_id)).length;
    const repeat = await survey(day, { ...anon, hour: 9, stylistSlug: 'dina' });
    assert.equal((await bookedFor(db, theirs.contact_id)).length, count, 'no duplicate');
    assertSaysNothingOf(repeat.body, theirs);

    assert.deepEqual(await contactRow(db, theirs.contact_id), before,
      "the client's name, phone, notes and session are as they were");
  } finally {
    await cleanup(db);
  }
});
