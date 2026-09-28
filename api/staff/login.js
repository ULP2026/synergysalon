/**
 * POST /api/staff/login — { email, password } -> a session cookie.
 *
 * Two things this is careful about.
 *
 * A wrong password and an unknown email give the same message and take about
 * the same time, so the form cannot be used to discover who works here.
 *
 * And repeated failures lock the account for a while. The counter lives on the
 * row rather than in memory, because serverless functions do not share memory:
 * an in-process counter resets on every cold start, which is to say it stops
 * nobody.
 */
import { assertSameOrigin, createSession } from '../_lib/auth.js';
import { query } from '../_lib/db.js';
import { HttpError, handler, json, readJson, requireEmail, requireString } from '../_lib/http.js';
import { verifyPassword } from '../_lib/password.js';
import { tenantForRequest } from '../_lib/tenant.js';

const MAX_ATTEMPTS = 8;
const LOCK_MINUTES = 15;

/** Deliberately identical for every kind of failure. */
const REJECTED = 'That email and password do not match.';

export default handler({
  async POST(req, res) {
    assertSameOrigin(req);
    const tenant = await tenantForRequest(req);
    const body = await readJson(req);

    const email = requireEmail(body.email);
    const password = requireString(body.password, 'Password', { max: 200 });

    const { rows } = await query(
      `SELECT id, tenant_id, email, password_hash, name, role, active,
              failed_attempts, locked_until
         FROM staff_users
        WHERE tenant_id = $1 AND lower(email) = $2`,
      [tenant.id, email],
    );
    const user = rows[0];

    if (user?.locked_until && new Date(user.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(user.locked_until) - Date.now()) / 60_000);
      throw new HttpError(429, `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
    }

    // Runs even when there is no such user, so the response time does not
    // reveal which addresses exist.
    const ok = await verifyPassword(password, user?.password_hash);

    if (!user || !ok || !user.active) {
      if (user) {
        const attempts = user.failed_attempts + 1;
        // Every parameter is cast. Postgres cannot resolve make_interval from
        // an untyped parameter, and without these casts a wrong password
        // raised a 500 instead of being rejected -- so the lockout never
        // counted, and the one path that must fail safely was the one that
        // crashed.
        await query(
          `UPDATE staff_users
              SET failed_attempts = $2::int,
                  locked_until = CASE WHEN $2::int >= $3::int
                                      THEN now() + make_interval(mins => $4::int)
                                      ELSE locked_until END
            WHERE id = $1`,
          [user.id, attempts, MAX_ATTEMPTS, LOCK_MINUTES],
        );
      }
      throw new HttpError(401, REJECTED);
    }

    await query(
      'UPDATE staff_users SET failed_attempts = 0, locked_until = NULL WHERE id = $1',
      [user.id],
    );
    await createSession(res, user, req.headers['user-agent']);

    return json(res, 200, {
      user: { name: user.name, email: user.email, role: user.role },
      salon: { name: tenant.name, timezone: tenant.timezone },
    });
  },
});
