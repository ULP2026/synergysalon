/**
 * GET /api/photo?stylist=<slug> — a stylist's own picture, as an image.
 *
 * Pictures are uploaded in the console and stored on the row as a data: URL,
 * because Vercel's filesystem is read-only at runtime and there is nowhere to
 * put a file. That is fine to keep, but handing it to the website was not:
 * /api/services is fetched by every visitor before they have chosen anything,
 * and four stylists' pictures inside that JSON is most of a megabyte of
 * base64 nobody asked for. So it listed the four portraits that exist as real
 * files and left everyone else without one, which is why somebody who set
 * their picture in the app still had none on the booking page.
 *
 * Serving it here instead gives the browser a URL: fetched once, cached, and
 * only for the stylists a guest actually sees. The response is immutable and
 * the caller puts a hash of the picture in the query string, so a new picture
 * is a new URL and an old one is never shown from cache.
 */
import { query } from './_lib/db.js';
import { HttpError, handler, json } from './_lib/http.js';
import { tenantForRequest } from './_lib/tenant.js';

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/;

export default handler({
  async GET(req, res) {
    const tenant = await tenantForRequest(req);
    const url = new URL(req.url, 'http://localhost');
    const slug = String(url.searchParams.get('stylist') || '').trim().toLowerCase();
    if (!/^[a-z0-9-]{1,80}$/.test(slug)) {
      throw new HttpError(400, 'Which stylist?');
    }

    // Only an active stylist of this salon, so the endpoint cannot be used to
    // read the picture of somebody who has left or works somewhere else.
    const { rows } = await query(
      `SELECT u.avatar
         FROM stylists s
         JOIN staff_users u ON u.id = s.staff_user_id
        WHERE s.tenant_id = $1 AND s.slug = $2 AND s.active`,
      [tenant.id, slug],
    );
    const avatar = rows[0]?.avatar || '';
    if (!avatar) return json(res, 404, { error: 'No picture for that stylist.' });

    // A built-in avatar is already a real file; send the browser there.
    if (avatar.startsWith('/assets/')) {
      res.statusCode = 302;
      res.setHeader('Location', avatar);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.end();
    }

    const m = DATA_URL.exec(avatar);
    if (!m) return json(res, 404, { error: 'No picture for that stylist.' });

    const body = Buffer.from(m[2], 'base64');
    res.statusCode = 200;
    res.setHeader('Content-Type', m[1]);
    res.setHeader('Content-Length', String(body.length));
    // Immutable: the caller's ?v= changes when the picture does, so a cached
    // copy is never the wrong one and a revalidation is never needed.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.end(body);
  },
});
