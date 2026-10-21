/**
 * GET /api/cron/sync: the daily catch-up for stylists' Google Calendars.
 *
 * Every booking, move and cancellation already copies itself to the stylist's
 * Google Calendar the moment it happens (google-mirror.js). This puts right
 * whatever failed there -- Google slow to answer, a token mid-refresh -- so a
 * copy that missed is at most a day behind.
 *
 * It used to drain sync_outbox into CENTRO as well. That was switched off on
 * 21 October 2026 at the salon's request: no client details, bookings or
 * changes are sent to CENTRO any more, from anywhere. The table stays, with
 * the jobs it holds, as the record of what was sent before then; nothing
 * writes to it or reads its pending rows. The path keeps its name so the
 * schedule in vercel.json is untouched.
 */
import { mirrorToGoogle } from '../_lib/google-mirror.js';
import { handler, json } from '../_lib/http.js';

/** Enough for a day's bookings at several salons, in one run a day. */
const DAILY_LIMIT = 200;

export default handler({
  async GET(req, res) {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.authorization !== `Bearer ${secret}`) {
      return json(res, 401, { error: 'Unauthorized' });
    }
    const copied = await mirrorToGoogle({ limit: DAILY_LIMIT });
    // A count only: the response is public when CRON_SECRET is unset.
    return json(res, 200, { googleCopies: copied.length });
  },
});
