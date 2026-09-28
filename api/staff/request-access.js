/**
 * POST /api/staff/request-access — ask the owner for a console account.
 *
 * This is the only unauthenticated write in the staff API, so it is
 * deliberately dull: it creates a row that can do nothing at all until an
 * owner approves it. A pending account cannot sign in, cannot hold a session,
 * and is invisible to every other endpoint.
 *
 * The reply is the same whether or not the address is already known. The
 * console holds the salon's entire client list, and a form that says "that
 * email already works here" tells a stranger who does.
 */
import { query } from '../_lib/db.js';
import {
  HttpError, handler, json, readJson, requireEmail, requireString,
} from '../_lib/http.js';
import { MIN_PASSWORD_LENGTH, hashPassword } from '../_lib/password.js';
import { tenantForRequest } from '../_lib/tenant.js';

const SENT = {
  ok: true,
  message: 'Your request has been sent to the salon owner. '
    + 'You will be able to sign in once it is approved.',
};

export default handler({
  async POST(req, res) {
    const tenant = await tenantForRequest(req);
    const body = await readJson(req);

    const name = requireString(body.name, 'Name', { max: 120 });
    const email = requireEmail(body.email);
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';
    const password = requireString(body.password, 'Password', { max: 200 });
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new HttpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }

    const { rows } = await query(
      'SELECT id, status FROM staff_users WHERE tenant_id = $1 AND lower(email) = $2',
      [tenant.id, email],
    );
    const existing = rows[0];

    // An existing active account is left completely alone. Otherwise anyone
    // could overwrite a stylist's password by "requesting access" as her.
    if (!existing) {
      await query(
        `INSERT INTO staff_users (tenant_id, email, password_hash, name, role, status, requested_at, note)
         VALUES ($1, $2, $3, $4, 'front_desk', 'pending', now(), $5)`,
        [tenant.id, email, await hashPassword(password), name, note],
      );
    } else if (existing.status === 'pending') {
      // Re-requesting is allowed: someone who mistyped their password and is
      // waiting anyway should not have to ask the owner to delete them first.
      await query(
        `UPDATE staff_users
            SET password_hash = $2, name = $3, note = $4, requested_at = now()
          WHERE id = $1`,
        [existing.id, await hashPassword(password), name, note],
      );
    }

    return json(res, 200, SENT);
  },
});
