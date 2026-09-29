/**
 * GET   /api/staff/business — what the shop tells its customers.
 * PATCH /api/staff/business — change it. Owners only.
 *
 * Deliberately narrow. This edits the shop's name, logo and contact details,
 * and nothing operational: not the timezone, which would move every slot in
 * the diary at once, not the hostname, which decides whose bookings arrive
 * here, and not the CRM credentials, which are never returned by any endpoint
 * to begin with. Those are support's job, and the blast radius is the reason.
 */
import { assertSameOrigin, requireStaff } from '../../_lib/auth.js';
import { query } from '../../_lib/db.js';
import {
  HttpError, handler, json, readJson, requireString,
} from '../../_lib/http.js';
import { tenantForUser } from '../../_lib/tenant.js';

/** Changing the face of the business is the owner's call, not a manager's. */
const CAN_EDIT = ['owner'];

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

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req);
    const tenant = await tenantForUser(user);
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
