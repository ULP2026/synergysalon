/**
 * /api/staff/karen-sms and /api/staff/karen-voice: the phone provider's
 * webhooks for Karen's number (asked for 2026-10-22).
 *
 * Under /api/staff only because the project is at Vercel's twelve-function
 * limit and this router is one function. Nothing here uses a staff session:
 * the caller is Twilio, proved by its signature over the exact URL and
 * fields (TWILIO_AUTH_TOKEN). Without the token every request is refused,
 * because the sender's number is what decides whose appointments Karen
 * reads out.
 *
 * Point the number's "A message comes in" webhook at .../karen-sms and its
 * "A call comes in" webhook at .../karen-voice, both HTTP POST.
 */
import { karenReply, tenantIdForKarenNumber, twilioSignatureOk, whoIsTexting } from '../../_lib/karen-sms.js';
import { query } from '../../_lib/db.js';
import { tenantForUser } from '../../_lib/tenant.js';

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function twiml(res, status, inner) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`);
}

/** Twilio posts a form; Vercel may already have parsed it. */
async function readForm(req) {
  if (req.body && typeof req.body === 'object') return Object.fromEntries(Object.entries(req.body).map(([k, v]) => [k, String(v)]));
  let raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) for await (const chunk of req) raw += chunk;
  return Object.fromEntries(new URLSearchParams(raw));
}

export default async function karenWebhook(req, res) {
  if (req.method !== 'POST') return twiml(res, 405, '');
  const voice = new URL(req.url, 'http://localhost').pathname.endsWith('karen-voice');
  const params = await readForm(req);
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  // Twilio signs the address it called. Vercel can hand this router that
  // address with its own ?action= added for the [action] segment, so the
  // address without it is checked too; neither is anything Twilio did not sign.
  const called = new URL(req.url, `https://${host}`);
  const urls = [`https://${host}${req.url}`];
  if (called.searchParams.has('action')) {
    called.searchParams.delete('action');
    urls.push(`https://${host}${called.pathname}${called.search}`);
  }
  const sig = req.headers['x-twilio-signature'];
  if (!urls.some((u) => twilioSignatureOk(u, params, sig, process.env.TWILIO_AUTH_TOKEN))) {
    console.warn('karen webhook refused: no valid Twilio signature', process.env.TWILIO_AUTH_TOKEN ? '' : '(TWILIO_AUTH_TOKEN is not set)');
    return twiml(res, 403, '');
  }
  try {
    const tenantId = await tenantIdForKarenNumber(params.To);
    if (!tenantId) {
      console.warn('karen webhook: no salon has this number as Karen\'s', params.To);
      return twiml(res, 200, voice ? '<Say>Sorry, this number is not set up yet.</Say>' : '');
    }
    const tenant = await tenantForUser({ tenant_id: tenantId });
    if (voice) {
      // Karen talks by text; a call is greeted by name and put through to
      // the salon, where there is one to put it through to.
      const who = await whoIsTexting({ query }, tenant.id, params.From);
      const hi = who.name ? `Hi ${xml(String(who.name).split(/\s+/)[0])}! ` : 'Hi! ';
      const salon = String(tenant.phone || '').replace(/[^\d+]/g, '');
      return twiml(res, 200, `<Say voice="Polly.Joanna">${hi}This is Karen, the assistant at ${xml(tenant.name)}. `
        + 'You can text this number any time to book, move or cancel an appointment.'
        + `${salon ? ' Let me put you through to the salon now.</Say>' + `<Dial>${xml(salon)}</Dial>` : ' Talk soon!</Say>'}`);
    }
    const say = await karenReply(tenant, params.From, params.Body || '');
    // Nothing to say to STOP, HELP and the like: the provider answers those.
    return twiml(res, 200, say ? `<Message>${xml(say)}</Message>` : '');
  } catch (err) {
    console.error('karen webhook failed', err);
    return twiml(res, 200, voice ? '<Say>Sorry, something went wrong. Please call the salon.</Say>'
      : '<Message>Sorry, something went wrong on my end. Please call the salon.</Message>');
  }
}
