/**
 * A pass that lets staff try the real booking popup while online booking is
 * paused for everyone else.
 *
 * Minted in the staff console, carried in a link to the public site, and sent
 * back by the page with each booking call. Signed, so nobody can make one;
 * short-lived, so a link that is forwarded stops working by itself. The key
 * is derived from DATABASE_URL, a secret every deployment already has, which
 * spares adding one more environment variable just for testing.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const TTL_MS = 12 * 60 * 60 * 1000;

function key() {
  const base = process.env.DATABASE_URL || '';
  if (!base) throw new Error('No DATABASE_URL, so no key to sign a booking preview with.');
  return createHash('sha256').update(`booking-preview:${base}`).digest();
}

function sign(body) {
  return createHmac('sha256', key()).update(body).digest('base64url');
}

export function mintPreview(tenantId, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ t: tenantId, exp: now + TTL_MS })).toString('base64url');
  return `${body}.${sign(body)}`;
}

/**
 * True when the request carries a valid, unexpired pass for this salon, or
 * comes in on one of this project's own *.vercel.app addresses.
 *
 * Those addresses are behind Vercel's login (deployment protection), so only
 * the team can open them, and the test link sent to the salon is one of them.
 * Without this its bookings were refused while the pause is on, and a test
 * booking never reached the app. Only this project's deployments receive
 * requests for its addresses, and Vercel sets the host header itself, so the
 * salon's own domain can never pass this way. If deployment protection is ever
 * switched off, these addresses become as open as the live site would be.
 */
export function previewAllowed(req, tenant, now = Date.now()) {
  // The Host header alone: Vercel routes on it, so it cannot name another
  // address than the one the request reached, unlike a forwarded header.
  const host = String(req.headers?.host || '').split(':')[0].toLowerCase();
  if (host.endsWith('.vercel.app')) return true;
  const raw = String(req.headers?.['x-booking-preview'] || '');
  const [body, sig] = raw.split('.');
  if (!body || !sig) return false;
  try {
    const want = Buffer.from(sign(body));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
    const { t, exp } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return t === tenant.id && Number(exp) > now;
  } catch {
    return false;
  }
}
