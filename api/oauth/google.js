/**
 * The Google connect popup: both halves of it.
 *
 *   GET /api/oauth/google?start=1   → sends the browser to Google's chooser
 *   GET /api/oauth/google?code=…    → Google sends the person back here
 *
 * One file because Vercel's Hobby plan counts files under api/ as functions,
 * and because the two halves only make sense together.
 *
 * The window is a popup, so the callback renders a page that tells the opener
 * what happened and closes itself. Nothing is passed back through the URL: the
 * opener already knows who it asked about, and a token in a query string ends
 * up in browser history.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { currentUser } from '../_lib/auth.js';
import { query } from '../_lib/db.js';
import { consentUrl, exchangeCode, googleConfigured } from '../_lib/google.js';
import { canStoreSecrets, encryptSecret } from '../_lib/secrets.js';

/**
 * The state parameter, signed.
 *
 * It says which user began this, and proves we said it. Without the signature
 * anybody could send somebody back to this callback naming a different user
 * and have their own Google account attached to that person's login.
 */
function sign(value) {
  const secret = process.env.SESSION_SECRET || process.env.TOKEN_KEY || '';
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function makeState(userId) {
  const body = `${userId}.${Date.now()}`;
  return `${body}.${sign(body)}`;
}

function readState(state) {
  const parts = String(state || '').split('.');
  if (parts.length !== 3) return null;
  const [userId, at, mac] = parts;
  const expected = sign(`${userId}.${at}`);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  // Ten minutes is longer than anybody takes to pick a Google account and
  // shorter than a link left in a chat window is useful for.
  if (Date.now() - Number(at) > 10 * 60_000) return null;
  return userId;
}

/** A popup that reports back to the console and closes itself. */
function closePage(res, ok, message) {
  const payload = JSON.stringify({ source: 'google-oauth', ok, message });
  res.status(ok ? 200 : 400);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(`<!doctype html><meta charset="utf-8"><title>${ok ? 'Connected' : 'Not connected'}</title>
<style>body{font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;display:grid;place-items:center;
height:100vh;margin:0;color:#17181c;background:#f6f6f4;text-align:center;padding:24px}
b{display:block;margin-bottom:6px}</style>
<div><b>${ok ? 'Connected to Google' : 'Not connected'}</b>
<span>${message}</span></div>
<script>
  try { window.opener && window.opener.postMessage(${payload}, window.location.origin); } catch (e) {}
  setTimeout(function () { window.close(); }, ${ok ? 900 : 3500});
</script>`);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).setHeader('Allow', 'GET');
    return res.end('Method not allowed');
  }

  const url = new URL(req.url, 'http://localhost');

  if (!googleConfigured()) {
    return closePage(res, false, 'Google is not set up on this site yet.');
  }
  if (!canStoreSecrets()) {
    // Refusing beats storing a refresh token in the clear and finding out later.
    return closePage(res, false, 'This site cannot store the connection securely yet.');
  }

  // ── half one: send them to Google ──────────────────────────────────────
  if (url.searchParams.get('start')) {
    const user = await currentUser(req);
    if (!user) return closePage(res, false, 'Please sign in again and retry.');
    res.status(302).setHeader('Location', consentUrl(req, makeState(user.id)));
    return res.end();
  }

  // ── half two: Google sends them back ───────────────────────────────────
  const error = url.searchParams.get('error');
  if (error) {
    return closePage(res, false, error === 'access_denied'
      ? 'You cancelled, so nothing was connected.'
      : `Google reported: ${error}`);
  }

  const code = url.searchParams.get('code');
  const userId = readState(url.searchParams.get('state'));
  if (!code || !userId) {
    return closePage(res, false, 'That link has expired. Please try connecting again.');
  }

  try {
    const tokens = await exchangeCode(req, code);
    if (!tokens.refresh_token) {
      // Google only sends one the first time unless prompt=consent is set,
      // which it is -- so this means something is wrong rather than normal.
      return closePage(res, false, 'Google did not return a lasting connection. Please try again.');
    }

    // Which account was actually connected, so the console can show it. The
    // id token carries it without a second API call.
    let email = '';
    if (tokens.id_token) {
      try {
        const claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString('utf8'));
        email = String(claims.email || '');
      } catch { /* the address is a nicety, not the connection */ }
    }

    await query(
      `UPDATE staff_users
          SET google_email = $2,
              google_refresh_token = $3,
              google_access_token = $4,
              google_expires_at = now() + make_interval(secs => $5::int),
              google_calendar_id = 'primary',
              google_connected_at = now()
        WHERE id = $1`,
      [userId, email, encryptSecret(tokens.refresh_token),
        encryptSecret(tokens.access_token), Number(tokens.expires_in || 3600)],
    );

    return closePage(res, true, email ? `Your appointments will appear in ${email}.` : 'You can close this window.');
  } catch (err) {
    console.error('google oauth failed', err);
    return closePage(res, false, 'Google could not complete the connection. Please try again.');
  }
}
