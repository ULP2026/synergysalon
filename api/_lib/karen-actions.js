/**
 * What Karen in the app may do, as opposed to say (asked for 2026-10-31:
 * "I should be able to ask Karen to send appointment reminders to all
 * clients scheduled for today").
 *
 * The rule is the one Karen by text already keeps: the model only proposes.
 * A proposal is checked here against the book (the appointments exist, are
 * this salon's, and are in a state the action makes sense for), stored for
 * the person who asked, and shown to them as a card with Confirm and
 * Cancel. Nothing happens until they confirm, and then it happens through
 * the app's own functions (the same emails the automations send, the same
 * appointment actions as the buttons), with what actually happened
 * reported back by code, never by the model. A proposal lives for one
 * reply and fifteen minutes: anything else said in between drops it.
 *
 * Kept apart from karen-desk.js, which only reads, so that file can go on
 * being checked for anything that writes.
 */
import crypto from 'node:crypto';

import { DateTime } from 'luxon';

import { applyAppointmentAction } from '../staff/_routes/appointment.js';
import { query } from './db.js';
import { automationOn, sendConfirmation, sendReminder } from './email.js';
import { visitLinesSql, visitNameSql } from './visit.js';

const TTL_MIN = 15;
const MAX_ITEMS = 60;

/** The emails Karen may send on request, and what each is called. */
export const SENDABLE = { reminder: 'reminder', confirmation: 'booking confirmation' };
/** The appointment actions Karen may take on request (never delete). */
export const DOABLE = {
  check_in: { verb: 'Check in', past: 'checked in' },
  no_show: { verb: 'Mark as no-show', past: 'marked as a no-show' },
  complete: { verb: 'Mark as done', past: 'marked as done' },
  cancel: { verb: 'Cancel', past: 'cancelled' },
};

/** Where one person's pending proposal is kept: karen_threads, keyed by them. */
const keyFor = (user) => `desk:${user.id}`;

async function rowsFor(tenant, refs, db) {
  const q = db ? db.query.bind(db) : query;
  const clean = [...new Set((refs || []).map((r) => String(r).trim().toUpperCase()).filter(Boolean))].slice(0, MAX_ITEMS);
  if (!clean.length) return { clean, rows: [] };
  const { rows } = await q(
    `SELECT a.*, s.name AS stylist_name, ${visitNameSql()} AS service_name, ${visitLinesSql()} AS lines
       FROM appointments a
       JOIN stylists s ON s.id = a.stylist_id
       JOIN services v ON v.id = a.service_id
      WHERE a.tenant_id = $1::uuid AND a.ref = ANY($2::text[])
      ORDER BY a.starts_at`,
    [tenant.id, clean],
  );
  return { clean, rows };
}

const at = (iso, zone) => DateTime.fromJSDate(new Date(iso)).setZone(zone);
const line = (a, zone) => `${a.guest_name} · ${at(a.starts_at, zone).toFormat('ccc, LLL d, h:mm a')} · ${a.service_name} with ${a.stylist_name}`;

/** Why an email of this kind would not go to this appointment, or null. */
function emailBar(kind, a) {
  if (a.status !== 'booked') return `it is ${a.status.replace('_', '-')}`;
  if (new Date(a.starts_at) <= new Date()) return 'it has already started';
  if (!a.guest_email) return 'there is no email address on it';
  return null;
}

/** Why this action does not fit this appointment, or null. */
function actionBar(action, a) {
  if (action === 'cancel') return a.status === 'cancelled' ? 'it is already cancelled' : null;
  if (a.status === 'cancelled') return 'it is cancelled';
  if (action === 'check_in' && a.checked_in_at) return 'they are already checked in';
  if (action === 'complete' && a.status === 'completed') return 'it is already done';
  if (action === 'no_show' && a.status === 'no_show') return 'it is already marked as a no-show';
  return null;
}

/**
 * Check a proposal and keep it for this person. Returns what the model is
 * told (what would happen, and to whom, and what would be left out and why)
 * and the card the console shows; or, when nothing would happen, only the
 * reason, and nothing is kept.
 */
export async function propose({ tenant, user, db = null }, input) {
  const zone = tenant.timezone;
  const isEmail = input.type === 'send_email';
  const kind = isEmail ? String(input.kind || '') : null;
  const action = isEmail ? null : String(input.action || '');
  if (isEmail && !SENDABLE[kind]) return { error: `I can send ${Object.keys(SENDABLE).join(' or ')} emails.` };
  if (!isEmail && !DOABLE[action]) return { error: `The appointment actions are ${Object.keys(DOABLE).join(', ')}.` };
  if (isEmail && !automationOn(kind, tenant)) {
    return { nothing: true, reason: `${SENDABLE[kind][0].toUpperCase()}${SENDABLE[kind].slice(1)} emails are switched off in Settings, Automations, so none would go. Switch them back on there first.` };
  }

  const { clean, rows } = await rowsFor(tenant, input.refs, db);
  if (!clean.length) return { error: 'Give the appointment refs from the appointments look-up.' };
  const found = new Map(rows.map((r) => [r.ref, r]));
  const go = [];
  const skipped = [];
  for (const ref of clean) {
    const a = found.get(ref);
    if (!a) { skipped.push({ ref, why: 'no such appointment' }); continue; }
    const bar = isEmail ? emailBar(kind, a) : actionBar(action, a);
    if (bar) skipped.push({ ref, client: a.guest_name, why: bar });
    else go.push(a);
  }
  if (!go.length) return { nothing: true, skipped };

  const n = go.length;
  const title = isEmail
    ? `Send ${n === 1 ? `a ${SENDABLE[kind]} email` : `${SENDABLE[kind]} emails to ${n} clients`}`
    : `${DOABLE[action].verb} ${n === 1 ? 'this appointment' : `${n} appointments`}`;
  const proposal = {
    id: crypto.randomUUID(),
    type: isEmail ? 'send_email' : 'appointment',
    kind, action,
    refs: go.map((a) => a.ref),
    title,
    lines: go.map((a) => line(a, zone)),
    // Already reminded: said on the card, so nobody is emailed twice by mistake.
    note: isEmail && kind === 'reminder' && go.some((a) => a.reminder_sent_at)
      ? `${go.filter((a) => a.reminder_sent_at).length} of them already had a reminder.` : null,
    at: new Date().toISOString(),
  };
  const q = db ? db.query.bind(db) : query;
  await q(
    `INSERT INTO karen_threads (tenant_id, phone, state, updated_at)
     VALUES ($1::uuid, $2, $3::jsonb, now())
     ON CONFLICT (tenant_id, phone) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [tenant.id, keyFor(user), JSON.stringify({ proposal })],
  );
  return {
    proposal: { id: proposal.id, title, lines: proposal.lines, note: proposal.note },
    will: proposal.lines,
    skipped,
  };
}

/** Drop whatever this person had pending (they said something else). */
export async function dropProposal({ tenant, user, db = null }) {
  const q = db ? db.query.bind(db) : query;
  await q("DELETE FROM karen_threads WHERE tenant_id = $1::uuid AND phone = $2", [tenant.id, keyFor(user)])
    .catch((err) => { if (err.code !== '42P01') throw err; });
}

/**
 * Carry out the proposal with this id, if it is still the one pending for
 * this person and not stale. Returns { say, done } with what happened,
 * written by code from the results.
 */
export async function confirm({ tenant, user, db = null }, id) {
  const q = db ? db.query.bind(db) : query;
  const { rows } = await q(
    `DELETE FROM karen_threads WHERE tenant_id = $1::uuid AND phone = $2 RETURNING state, updated_at`,
    [tenant.id, keyFor(user)],
  );
  const p = rows[0]?.state?.proposal;
  if (!p || p.id !== id) return { say: "That's no longer waiting on you, so I haven't done anything. Ask me again and I'll set it up.", done: false };
  if (Date.now() - new Date(p.at).getTime() > TTL_MIN * 60_000) {
    return { say: `That was set up more than ${TTL_MIN} minutes ago, so I haven't done it. Ask me again and I'll check it fresh.`, done: false };
  }

  const zone = tenant.timezone;
  const { rows: appts } = await rowsFor(tenant, p.refs, db);
  const ok = [];
  const no = [];
  for (const a of appts) {
    const first = a.guest_name || 'the client';
    if (p.type === 'send_email') {
      // Checked again: something may have changed since it was proposed.
      const bar = emailBar(p.kind, a);
      if (bar) { no.push(`${first} (${bar})`); continue; }
      try {
        const out = p.kind === 'reminder' ? await sendReminder(a, tenant) : await sendConfirmation(a, tenant);
        if (out?.sent) {
          ok.push(first);
          if (p.kind === 'reminder') {
            // So the daily reminder run does not send it a second time.
            await q('UPDATE appointments SET reminder_sent_at = now() WHERE id = $1::uuid', [a.id]);
          }
        } else if (out?.off) no.push(`${first} (switched off in Settings, Automations)`);
        else no.push(`${first} (email isn't connected, so nothing went)`);
      } catch (err) {
        no.push(`${first} (the email provider refused it: ${String(err.message || err).replace(/^Resend refused the message: /, '')})`);
      }
    } else {
      const bar = actionBar(p.action, a);
      if (bar) { no.push(`${first} (${bar})`); continue; }
      try {
        await applyAppointmentAction(tenant, user, a.ref, p.action);
        ok.push(`${first} at ${at(a.starts_at, zone).toFormat('h:mm a')}`);
      } catch (err) {
        no.push(`${first} (${err.message || 'it did not go through'})`);
      }
    }
  }

  const list = (xs) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
  const what = p.type === 'send_email' ? `${SENDABLE[p.kind]} email` : null;
  let say;
  if (ok.length) {
    say = p.type === 'send_email'
      ? `Done. I sent the ${what}${ok.length === 1 ? '' : 's'} to ${list(ok)}.`
      : `Done. ${list(ok)} ${ok.length === 1 ? 'is' : 'are'} ${DOABLE[p.action].past}.`;
  } else {
    say = "I couldn't do any of it.";
  }
  if (no.length) say += ` Not done for ${list(no)}.`;
  return { say, done: ok.length > 0, results: { done: ok, notDone: no } };
}
