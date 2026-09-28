/** POST /api/staff/logout — drops the session on the server, not just the cookie. */
import { assertSameOrigin, destroySession } from '../../_lib/auth.js';
import { handler, json } from '../../_lib/http.js';

export default handler({
  async POST(req, res) {
    assertSameOrigin(req);
    await destroySession(req, res);
    return json(res, 200, { ok: true });
  },
});
