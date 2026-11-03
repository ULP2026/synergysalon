/**
 * Whose appointments, clients and calendar a team member may see (asked for
 * 2026-11-03): the salon owner sees everyone's; everybody else, stylists
 * included, sees only their own chair, its appointments and the clients
 * booked into it, and their own account.
 *
 * "The owner" is the app's one admin rule, canManageTeam (auth.js): role
 * Owner or Admin, or the agency's support login. One rule, so the screens
 * and the server can never disagree about who that is.
 *
 * Every endpoint that returns appointments, clients or team details asks
 * here, on the server: the console hides what it cannot show, but hiding a
 * screen never kept anybody out of the API.
 */
import { canManageTeam } from './auth.js';
import { query } from './db.js';
import { HttpError } from './http.js';

/** Whether this person sees the whole salon. */
export function seesAll(user) {
  return canManageTeam(user);
}

/**
 * The person's own chair: the stylist rows linked to their login, as ids and
 * slugs. null means everyone (the owner). An empty list means nobody: a team
 * member with no chair sees no appointments at all.
 */
export async function chairOf(user, db = null) {
  if (seesAll(user)) return null;
  const q = db ? db.query.bind(db) : query;
  const { rows } = await q(
    'SELECT id, slug FROM stylists WHERE staff_user_id = $1::uuid AND tenant_id = $2::uuid',
    [user.id, user.tenant_id],
  );
  return { ids: rows.map((r) => r.id), slugs: rows.map((r) => r.slug) };
}

/** The ids to filter by in SQL (`$n::uuid[] IS NULL OR stylist_id = ANY($n)`): null for everyone. */
export const chairIds = (chair) => (chair ? chair.ids : null);
export const chairSlugs = (chair) => (chair ? chair.slugs : null);

/** Whether an appointment's stylist is in this chair. */
export function inChair(chair, stylistId) {
  return !chair || chair.ids.some((id) => String(id) === String(stylistId));
}

/**
 * SQL for "this client is in the person's book": booked into their chair at
 * least once (any status), or added by them. Takes the placeholder numbers of
 * the chair's ids (uuid[] or NULL for everyone) and the user's id.
 */
export function clientInChairSql(alias, idsParam, userParam) {
  return `(${idsParam}::uuid[] IS NULL
           OR ${alias}.created_by = ${userParam}::uuid
           OR EXISTS (SELECT 1 FROM appointments sca
                       WHERE sca.contact_id = ${alias}.id AND sca.stylist_id = ANY(${idsParam}::uuid[])))`;
}

/** Throws a 404 (not a 403: it does not say the client exists) unless the client is in their book. */
export async function assertClientInChair(user, contactId, chair, db = null) {
  if (!chair) return;
  const q = db ? db.query.bind(db) : query;
  const { rows } = await q(
    `SELECT 1 FROM contacts c WHERE c.id = $1::uuid AND c.tenant_id = $2::uuid
        AND ${clientInChairSql('c', '$3', '$4')}`,
    [contactId, user.tenant_id, chair.ids, user.id],
  );
  if (!rows[0]) throw new HttpError(404, 'No such client.');
}

/**
 * The stylist a desk booking or an availability question may name: anyone
 * for the owner (as asked, or null for "first available"); for everyone else
 * their own chair only, whatever was asked.
 */
export async function bookableSlug(user, asked) {
  const chair = await chairOf(user);
  if (!chair) return asked || null;
  if (!chair.slugs.length) throw new HttpError(403, 'You have no chair to book into yet. Ask the salon owner to switch on your services.');
  if (asked && !chair.slugs.includes(asked)) throw new HttpError(403, 'You can only book into your own chair.');
  return asked || chair.slugs[0];
}
