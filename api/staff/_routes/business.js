/**
 * GET   /api/staff/business: what the shop tells its customers.
 * PATCH /api/staff/business: change it. Owners and managers.
 *
 * Deliberately narrow. This edits the shop's name, logo and contact details,
 * and nothing operational: not the timezone, which would move every slot in
 * the diary at once, not the hostname, which decides whose bookings arrive
 * here, and not the CRM credentials, which are never returned by any endpoint
 * to begin with. Those are support's job, and the blast radius is the reason.
 */
import { DateTime } from 'luxon';

import { assertSameOrigin, requireStaff } from '../../_lib/auth.js';
import { query } from '../../_lib/db.js';
import { MESSAGE_KINDS, automationOn, previewMessage } from '../../_lib/email.js';
import {
  HttpError, handler, json, readJson, requireEmail, requireString,
} from '../../_lib/http.js';
import { tenantForUser } from '../../_lib/tenant.js';

/**
 * The same people who run Settings. Owner-only left the salon's own manager
 * looking at a form they could not type in, while the address and phone
 * customers see needed fixing; front desk still only reads it.
 */
const CAN_EDIT = ['owner', 'admin', 'manager'];

const MAX_LOGO = 400 * 1024;

function logoFrom(value) {
  if (value === null) return null;
  const s = String(value || '').trim();
  if (!s) return undefined;
  if (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(s)) {
    throw new HttpError(400, 'That does not look like an image.');
  }
  if (s.length > MAX_LOGO) {
    throw new HttpError(413, 'That logo is too large. Please choose a smaller one.');
  }
  return s;
}

/**
 * GET ?preview=confirmation|reminder|reschedule|cancellation: a guest message
 * rendered by the same code that sends it, for Marketing, Automation.
 *
 * Lives here because it is the shop's own voice to its customers, and a new
 * file under api/ would cost a serverless function. The appointment in it is
 * a sample: tomorrow at 10, the shop's first service and stylist, and a price
 * only if the shop has set one, so the preview never shows a made-up figure.
 */
async function preview(kind, tenant) {
  if (!MESSAGE_KINDS.includes(kind)) throw new HttpError(404, 'No such message.');
  const [svc, sty] = await Promise.all([
    // duration_min as well as the price: without it the sample has no length,
    // so the preview drops the "How long" row and the add-to-calendar link,
    // and staff read a message missing two things a guest actually receives.
    query(`SELECT name, price_cents, duration_min FROM services
            WHERE tenant_id = $1 AND active ORDER BY sort_order LIMIT 1`, [tenant.id]),
    query(`SELECT name FROM stylists WHERE tenant_id = $1 AND active
            ORDER BY sort_order LIMIT 1`, [tenant.id]),
  ]);
  const start = DateTime.now().setZone(tenant.timezone || 'America/New_York')
    .plus({ days: 1 }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
  const appt = {
    guest_name: 'Jamie Sample',
    guest_email: 'jamie@example.com',
    service_name: svc.rows[0]?.name || 'Your service',
    stylist_name: sty.rows[0]?.name || 'Your stylist',
    price_cents: svc.rows[0]?.price_cents ?? null,
    duration_min: svc.rows[0]?.duration_min ?? 60,
    starts_at: start.toJSDate(),
    ref: 'SAMPLE',
    manage_token: 'preview',
  };
  const out = previewMessage(kind, appt, tenant, start.minus({ days: 1 }).toJSDate());
  return { kind, to: `${appt.guest_name} <${appt.guest_email}>`, ...out };
}

/**
 * How many of each message have gone out, and whether the automation is on.
 *
 * Counts start the day migration 024 ran: nothing recorded a send before it,
 * so there is nothing honest to backfill from. The whole thing degrades to
 * zeroes when that migration has not run yet, because this is a number on a
 * screen and not worth taking Marketing down over.
 */
async function automations(tenant) {
  const counts = await query(
    `SELECT kind, count(*)::int AS sent, max(sent_at) AS last_sent
       FROM message_sends WHERE tenant_id = $1 GROUP BY kind`,
    [tenant.id],
  ).catch(() => ({ rows: [] }));

  const by = new Map(counts.rows.map((r) => [r.kind, r]));
  return {
    kinds: MESSAGE_KINDS.map((kind) => ({
      kind,
      on: automationOn(kind, tenant),
      sent: by.get(kind)?.sent ?? 0,
      lastSent: by.get(kind)?.last_sent ?? null,
    })),
  };
}

/**
 * Who received one of them, newest first.
 *
 * The name and address come off the log row rather than a join back to the
 * contact, because this answers "who did we email", which is a fact about the
 * past: a guest who has since changed their address, or been deleted, still
 * received it.
 */
async function recipients(kind, tenant) {
  if (!MESSAGE_KINDS.includes(kind)) throw new HttpError(404, 'No such message.');
  const { rows } = await query(
    `SELECT m.to_name, m.to_email, m.sent_at, a.ref
       FROM message_sends m
       LEFT JOIN appointments a ON a.id = m.appointment_id
      WHERE m.tenant_id = $1 AND m.kind = $2
      ORDER BY m.sent_at DESC LIMIT 200`,
    [tenant.id, kind],
  ).catch(() => ({ rows: [] }));
  return {
    kind,
    people: rows.map((r) => ({
      name: r.to_name || r.to_email,
      email: r.to_email,
      sentAt: r.sent_at,
      ref: r.ref || null,
    })),
  };
}

/**
 * GET ?history=1[&before=<cursor>]: every email the automations have sent,
 * newest first, a page at a time, for the history under Marketing.
 *
 * From the send log, so it lists what actually went out: a message Resend
 * refused, or one whose automation was switched off, was never recorded.
 * The log starts the day migration 024 ran; there is nothing earlier to show.
 *
 * Paged by (sent_at, id) rather than by time alone, so two emails sent in the
 * same instant are neither skipped nor shown twice at a page boundary. The
 * cursor carries sent_at as Postgres's own text, microseconds included: a
 * JavaScript Date would round it to the millisecond and lose rows.
 */
const HISTORY_PAGE = 50;
export async function history(tenant, cursor) {
  const [at, id] = String(cursor || '').split('|');
  const after = at && id && !Number.isNaN(Date.parse(at)) && /^[0-9a-f-]{36}$/i.test(id);
  const { rows } = await query(
    `SELECT m.id, m.kind, m.to_name, m.to_email, m.sent_at, m.sent_at::text AS at, a.ref
       FROM message_sends m
       LEFT JOIN appointments a ON a.id = m.appointment_id
      WHERE m.tenant_id = $1
        AND ($2::timestamptz IS NULL OR (m.sent_at, m.id) < ($2::timestamptz, $3::uuid))
      ORDER BY m.sent_at DESC, m.id DESC
      LIMIT $4::int`,
    [tenant.id, after ? at : null, after ? id : null, HISTORY_PAGE + 1],
  ).catch(() => ({ rows: [] }));
  const page = rows.slice(0, HISTORY_PAGE);
  const last = page[page.length - 1];
  return {
    sends: page.map((r) => ({
      kind: r.kind,
      name: r.to_name || r.to_email,
      email: r.to_email,
      sentAt: r.sent_at,
      ref: r.ref || null,
    })),
    next: rows.length > HISTORY_PAGE && last ? `${last.at}|${last.id}` : null,
  };
}

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);
    const q = new URL(req.url, 'http://localhost').searchParams;
    const kind = q.get('preview');
    if (kind) return json(res, 200, await preview(kind, tenant));
    if (q.has('automations')) return json(res, 200, await automations(tenant));
    if (q.has('history')) return json(res, 200, await history(tenant, q.get('before')));
    const who = q.get('recipients');
    if (who) return json(res, 200, await recipients(who, tenant));
    const { rows } = await query(
      `SELECT name, slug, logo, address, phone, email, website, about, timezone,
              host, app_host, to_jsonb(tenants) ->> 'reply_to' AS reply_to,
              -- Through to_jsonb, so Settings still loads before migration 026.
              to_jsonb(tenants) ->> 'review_url' AS review_url
         FROM tenants WHERE id = $1`,
      [tenant.id],
    );
    const t = rows[0];
    return json(res, 200, {
      name: t.name,
      slug: t.slug,
      logo: t.logo,
      address: t.address,
      phone: t.phone,
      email: t.email,
      replyTo: t.reply_to || '',
      // Where the review request email sends people. Empty until it is set,
      // and that email is not queued at all while it is empty: asking for a
      // review with nowhere to leave one wastes the one ask you get.
      reviewUrl: t.review_url || '',
      website: t.website,
      about: t.about,
      // Shown, never edited here: an owner should be able to see what their
      // booking link is and what clock the diary runs on without being handed
      // the controls that would break both.
      timezone: t.timezone,
      bookingUrl: t.host ? `https://${t.host}` : `/s/${t.slug}`,
      canEdit: CAN_EDIT.includes(user.role),
    });
  },

  async PATCH(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req, CAN_EDIT);
    const tenant = await tenantForUser(user);
    const body = await readJson(req);

    // Switching an automation on or off, from Marketing. Its own branch and
    // its own reply, because it has nothing to do with the shop's address and
    // the caller is a different screen.
    if (body.automation !== undefined) {
      const kind = String(body.automation);
      if (!MESSAGE_KINDS.includes(kind)) throw new HttpError(404, 'No such automation.');
      const on = body.on !== false;
      await query(
        on
          ? `UPDATE tenants SET automations_off = array_remove(automations_off, $2) WHERE id = $1`
          : `UPDATE tenants
                SET automations_off = (
                  SELECT array_agg(DISTINCT k) FROM unnest(automations_off || $2::text) AS k)
              WHERE id = $1`,
        [tenant.id, kind],
      );
      return json(res, 200, { automation: kind, on });
    }

    const sets = [];
    const params = [tenant.id];
    const add = (col, value) => { params.push(value); sets.push(`${col} = $${params.length}`); };
    const text = (v, max) => String(v || '').trim().slice(0, max);

    if (body.name !== undefined) add('name', requireString(body.name, 'Business name', { max: 120 }));
    if (body.address !== undefined) add('address', text(body.address, 300));
    if (body.phone !== undefined) add('phone', text(body.phone, 40));
    if (body.email !== undefined) add('email', text(body.email, 254).toLowerCase());
    if (body.about !== undefined) add('about', text(body.about, 1000));
    // Empty is allowed, and means "use the profile email" again.
    if (body.replyTo !== undefined) {
      const to = text(body.replyTo, 254).toLowerCase();
      add('reply_to', to ? requireEmail(to, 'Reply-to email') : null);
    }

    // Emptying it is allowed, and switches the review request back off.
    if (body.reviewUrl !== undefined) {
      const link = text(body.reviewUrl, 400);
      if (link && !/^https:\/\//i.test(link)) {
        throw new HttpError(400, 'A review link must start with https://');
      }
      add('review_url', link || null);
    }

    if (body.website !== undefined) {
      const site = text(body.website, 200);
      // Stored with a scheme so it is a link wherever it is printed, rather
      // than something that resolves relative to whatever page shows it.
      add('website', site && !/^https?:\/\//i.test(site) ? `https://${site}` : site);
    }

    const logo = logoFrom(body.logo);
    if (logo !== undefined) add('logo', logo);

    if (!sets.length) throw new HttpError(400, 'Nothing to change.');

    const { rows } = await query(
      `UPDATE tenants SET ${sets.join(', ')} WHERE id = $1
        RETURNING name, logo, address, phone, email, website, about,
                  COALESCE(reply_to, '') AS "replyTo"`,
      params,
    );
    return json(res, 200, { ...rows[0], saved: true });
  },
});
