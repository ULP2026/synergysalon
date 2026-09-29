/**
 * /api/staff/centro: is the diary reaching CENTRO?
 *
 *   GET    the link, what is queued, and anything CENTRO refused
 *   POST   { action: 'retry' } put refused jobs back in the queue and send
 *
 * Owners and managers only. Before this existed, a booking CENTRO refused
 * looked exactly like one still on its way, and five sat failed unnoticed.
 */
import { assertSameOrigin, requireStaff } from '../../_lib/auth.js';
import { HttpError, handler, json, readJson } from '../../_lib/http.js';
import { tenantForUser } from '../../_lib/tenant.js';
import { centroStatus } from '../../cron/sync.js';

const ADMIN = ['owner', 'manager'];

export default handler({
  async GET(req, res) {
    const user = await requireStaff(req, ADMIN);
    const tenant = await tenantForUser(user);
    return json(res, 200, await centroStatus(tenant.id));
  },

  async POST(req, res) {
    assertSameOrigin(req);
    const user = await requireStaff(req, ADMIN);
    const tenant = await tenantForUser(user);
    const body = await readJson(req);
    if (body.action !== 'retry') throw new HttpError(400, 'Nothing to do.');
    return json(res, 200, await centroStatus(tenant.id, { retry: true }));
  },
});
