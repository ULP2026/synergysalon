/**
 * Which salon is this request about?
 *
 * Staff requests answer it from the session, so a signed-in user can only
 * ever act on their own salon regardless of what they send. Public requests
 * answer it from the hostname, with an environment variable as the fallback
 * for local work and preview deploys.
 *
 * A guest may name a salon by slug, but only when the hostname does not
 * already answer the question, and only on the public endpoints. The
 * distinction matters: naming a salon on a *staff* endpoint is how one salon
 * ends up reading another's diary, which is why the staff path resolves from
 * the session and nothing else. On the public path the guest is choosing whose
 * booking page to open -- they see services and free slots, and create their
 * own appointment. That is the same information the salon prints on its door.
 *
 * A salon with its own domain is matched by host and the slug is ignored, so
 * a shop cannot be addressed under a competitor's domain.
 */
import { query } from './db.js';
import { HttpError } from './http.js';

async function bySlug(slug) {
  const { rows } = await query(
    `SELECT id, slug, name, timezone, host, app_host,
            address, phone, email, website, logo,
            -- Through to_jsonb, so this still reads before migration 017.
            to_jsonb(tenants) ->> 'reply_to' AS reply_to,
            ghl_location_id, ghl_calendar_id
       FROM tenants WHERE slug = $1 AND active`,
    [slug],
  );
  return rows[0] ?? null;
}

/**
 * Matches either the public site or the staff console's own subdomain, so
 * app.synergysalon.com resolves to the same salon as synergysalon.com without
 * the console having to say which tenant it means.
 */
async function byHost(host) {
  const { rows } = await query(
    `SELECT id, slug, name, timezone, host, app_host,
            address, phone, email, website, logo,
            -- Through to_jsonb, so this still reads before migration 017.
            to_jsonb(tenants) ->> 'reply_to' AS reply_to,
            ghl_location_id, ghl_calendar_id
       FROM tenants WHERE (host = $1 OR app_host = $1) AND active`,
    [host],
  );
  return rows[0] ?? null;
}

/**
 * Note what this never selects: ghl_token. The token lives in the row but is
 * only ever read by the sync worker, so it cannot leak through an endpoint
 * that happens to return its tenant.
 */
export async function tenantForRequest(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(':')[0]
    .replace(/^www\./, '');

  // Host first, always: a salon that has pointed a domain here owns that
  // domain's traffic, whatever the URL asks for.
  let found = host && await byHost(host);

  // Then the slug, for the shops that have no domain of their own yet. Most
  // new customers never will -- they have a Facebook page and a phone number.
  if (!found) {
    const url = new URL(req.url, 'http://localhost');
    const asked = (url.searchParams.get('salon') || '').trim().toLowerCase();
    if (/^[a-z0-9][a-z0-9-]{1,48}$/.test(asked)) found = await bySlug(asked);
  }

  if (!found && process.env.DEFAULT_TENANT) found = await bySlug(process.env.DEFAULT_TENANT);

  if (!found) {
    throw new HttpError(404, 'No salon is configured for this address.');
  }
  return found;
}

export async function tenantForUser(user) {
  const { rows } = await query(
    `SELECT id, slug, name, timezone, host, app_host,
            address, phone, email, website, logo,
            -- Through to_jsonb, so this still reads before migration 017.
            to_jsonb(tenants) ->> 'reply_to' AS reply_to,
            ghl_location_id, ghl_calendar_id
       FROM tenants WHERE id = $1 AND active`,
    [user.tenant_id],
  );
  if (!rows[0]) throw new HttpError(403, 'That salon is not active.');
  return rows[0];
}
