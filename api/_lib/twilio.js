import { toGsm } from './sms-length.js';

/**
 * Send a text from Karen's number through the phone provider's API: how a
 * reply goes out when it is not the webhook's own answer (Karen on Claude
 * answers after the webhook has returned), and how appointment texts go out
 * (sms-notify.js). A file of its own so email.js can reach it without
 * importing Karen. Needs TWILIO_ACCOUNT_SID beside the auth token.
 */
export async function sendText({ to, from, body }, fetchImpl = fetch) {
  // Every text in the plain alphabet (sms-length.js): one curly apostrophe
  // would send it all at 70 characters a segment instead of 160.
  body = toGsm(body);
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are needed to send a text');
  const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  if (!res.ok) {
    const why = await res.text().catch(() => '');
    throw new Error(`Twilio refused the text (${res.status}): ${why.slice(0, 300)}`);
  }
  return res.json();
}
