/**
 * Which salon is this request about?
 *
 * Staff requests answer it from the session, so a signed-in user can only
 * ever act on their own salon regardless of what they send. Public requests
 * answer it from the hostname, with an environment variable as the fallback
 * for local work and preview deploys.
 *
 * There is deliberately no way for a guest to name a tenant in a query
 * string: that is how one salon ends up reading another's diary.
 */
import { query } from './db.js';
import { HttpError } from './http.js';

async function bySlug(slug) {
  const { rows } = await query(
    `SELECT id, slug, name, timezone, host, ghl_location_id, ghl_calendar_id
       FROM tenants WHERE slug = $1 AND active`,
    [slug],
  );
  return rows[0] ?? null;
}

async function byHost(host) {
  const { rows } = await query(
    `SELECT id, slug, name, timezone, host, ghl_location_id, ghl_calendar_id
       FROM tenants WHERE host = $1 AND active`,
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

  const found = (host && await byHost(host))
    || (process.env.DEFAULT_TENANT && await bySlug(process.env.DEFAULT_TENANT));

  if (!found) {
    throw new HttpError(404, 'No salon is configured for this address.');
  }
  return found;
}

export async function tenantForUser(user) {
  const { rows } = await query(
    `SELECT id, slug, name, timezone, host, ghl_location_id, ghl_calendar_id
       FROM tenants WHERE id = $1 AND active`,
    [user.tenant_id],
  );
  if (!rows[0]) throw new HttpError(403, 'That salon is not active.');
  return rows[0];
}
