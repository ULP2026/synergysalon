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
import { MESSAGE_KINDS, previewMessage } from '../../_lib/email.js';
import {
  HttpError, handler, json, readJson, requireString,
} from '../../_lib/http.js';
import { tenantForUser } from '../../_lib/tenant.js';

/**
 * The same people who run Settings. Owner-only left the salon's own manager
 * looking at a form they could not type in, while the address and phone
 * customers see needed fixing; front desk still only reads it.
 */
const CAN_EDIT = ['owner', 'manager'];

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
    query(`SELECT name, price_cents FROM services WHERE tenant_id = $1 AND active
            ORDER BY sort_order LIMIT 1`, [tenant.id]),
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
    starts_at: start.toJSDate(),
    ref: 'SAMPLE',
    manage_token: 'preview',
  };
  const out = previewMessage(kind, appt, tenant, start.minus({ days: 1 }).toJSDate());
  return { kind, to: `${appt.guest_name} <${appt.guest_email}>`, ...out };
}

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);
    const kind = new URL(req.url, 'http://localhost').searchParams.get('preview');
    if (kind) return json(res, 200, await preview(kind, tenant));
    const { rows } = await query(
      `SELECT name, slug, logo, address, phone, email, website, about, timezone,
              host, app_host
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

    const sets = [];
    const params = [tenant.id];
    const add = (col, value) => { params.push(value); sets.push(`${col} = $${params.length}`); };
    const text = (v, max) => String(v || '').trim().slice(0, max);

    if (body.name !== undefined) add('name', requireString(body.name, 'Business name', { max: 120 }));
    if (body.address !== undefined) add('address', text(body.address, 300));
    if (body.phone !== undefined) add('phone', text(body.phone, 40));
    if (body.email !== undefined) add('email', text(body.email, 254).toLowerCase());
    if (body.about !== undefined) add('about', text(body.about, 1000));

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
        RETURNING name, logo, address, phone, email, website, about`,
      params,
    );
    return json(res, 200, { ...rows[0], saved: true });
  },
});
