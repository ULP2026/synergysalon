/**
 * Guest email: confirmation, reschedule, cancellation and the day-before
 * reminder.
 *
 * Sending is always best-effort. A booking that is safely in the database has
 * happened, and throwing away a real appointment because a mail provider had
 * a bad minute would be the worse failure. Callers log and carry on.
 */
import { DateTime } from 'luxon';
import { Resend } from 'resend';

import { shopFrom } from './config.js';

/**
 * Who the message is from.
 *
 * One address for every shop, because the sending domain has to be one we
 * have verified with the provider -- a shop's own address in the From header
 * is what gets the whole platform marked as spam. The shop's name still leads
 * it, so a guest sees who is writing, and replies go to the shop itself.
 */
const SENDER = process.env.BOOKING_FROM_EMAIL || 'bookings@synergysalon.com';

function fromFor(shop) {
  const match = String(SENDER).match(/<([^>]+)>/);
  const address = match ? match[1] : SENDER;
  return `${shop.name} <${address}>`;
}

function client() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (!globalThis.__synergyResend) globalThis.__synergyResend = new Resend(key);
  return globalThis.__synergyResend;
}

/**
 * Where a guest reschedules or cancels.
 *
 * Built on the shop's own site where it has one, so the link a guest clicks
 * carries the name they recognise rather than the platform's.
 */
export function manageUrl(shop, ref, token) {
  const base = shop && shop.site ? shop.site : '';
  return `${base}/appointment?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(token)}`;
}

/**
 * "Wednesday 1 October 2026 at 2:30 PM" -- unambiguous, and never a numeric
 * date, because 01/10 means two different days either side of the Atlantic.
 * Always rendered on the salon's clock, not the server's.
 */
export function prettyWhen(startsAt, zone = DEFAULT_TZ) {
  return DateTime.fromJSDate(new Date(startsAt))
    .setZone(zone)
    .toFormat("cccc d LLLL yyyy 'at' h:mm a");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function layout({ heading, intro, rows, action, steps, footnote }, shop) {
  const cells = rows
    .map(([label, value]) => `
      <tr>
        <td style="padding:6px 16px 6px 0;color:#6b6b6b;font-size:14px;">${escapeHtml(label)}</td>
        <td style="padding:6px 0;color:#1b1b1b;font-size:14px;font-weight:600;">${escapeHtml(value)}</td>
      </tr>`)
    .join('');

  const button = action
    ? `<p style="margin:28px 0 0;">
         <a href="${action.href}" style="background:#e07a3f;color:#fff;text-decoration:none;
            padding:12px 22px;border-radius:999px;font-weight:600;font-size:15px;display:inline-block;">
           ${escapeHtml(action.label)}
         </a>
       </p>`
    : '';

  // Numbered instructions, for the one message that has any: the welcome.
  const list = steps && steps.items && steps.items.length
    ? `<h2 style="margin:32px 0 4px;font-size:16px;color:#1b1b1b;">${escapeHtml(steps.title || 'What to do next')}</h2>
       <ol style="margin:0;padding:0 0 0 20px;color:#4a4a4a;font-size:14px;line-height:1.6;">
         ${steps.items.map((it) => `<li style="margin:10px 0 0;"><b style="color:#1b1b1b;">${escapeHtml(it.title)}</b><br>${escapeHtml(it.text)}</li>`).join('')}
       </ol>`
    : '';

  return `<!doctype html>
<html lang="en"><body style="margin:0;background:#faf8f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px;">
    <h1 style="margin:0 0 8px;font-size:22px;color:#1b1b1b;">${escapeHtml(heading)}</h1>
    <p style="margin:0 0 24px;color:#4a4a4a;font-size:15px;line-height:1.55;">${escapeHtml(intro)}</p>
    <table style="border-collapse:collapse;">${cells}</table>
    ${button}
    ${list}
    ${footnote ? `<p style="margin:28px 0 0;color:#6b6b6b;font-size:13px;line-height:1.55;">${escapeHtml(footnote)}</p>` : ''}
    <hr style="border:none;border-top:1px solid #e8e2dc;margin:28px 0 16px;">
    <p style="margin:0;color:#6b6b6b;font-size:13px;line-height:1.6;">
      ${escapeHtml(shop.name)}<br>
      ${shop.addressLines.map(escapeHtml).join('<br>')}${shop.addressLines.length ? '<br>' : ''}
      ${shop.phone ? `<a href="${shop.phoneHref}" style="color:#6b6b6b;">${escapeHtml(shop.phone)}</a>` : ''}
    </p>
  </div>
</body></html>`;
}

function plain({ heading, intro, rows, action, steps, footnote }, shop) {
  return [
    heading,
    '',
    intro,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    ...(action ? ['', `${action.label}: ${action.href}`] : []),
    ...(steps && steps.items && steps.items.length
      ? ['', steps.title || 'What to do next', ...steps.items.map((it, i) => `${i + 1}. ${it.title}: ${it.text}`)]
      : []),
    ...(footnote ? ['', footnote] : []),
    '',
    shop.name,
    ...shop.addressLines,
    shop.phone,
  ].join('\n');
}

async function send(shop, to, subject, content) {
  const resend = client();
  if (!resend) {
    console.warn('RESEND_API_KEY is not set; skipping email to', to);
    return { skipped: true };
  }
  const { error } = await resend.emails.send({
    from: fromFor(shop),
    replyTo: shop.replyTo || undefined,
    to,
    subject,
    html: layout(content, shop),
    text: plain(content, shop),
  });
  if (error) throw new Error(`Resend refused the message: ${error.message}`);
  return { sent: true };
}

function detailRows(appt, zone) {
  const rows = [
    ['Service', appt.service_name],
    ['With', appt.stylist_name],
    ['When', prettyWhen(appt.starts_at, zone)],
    ['Reference', appt.ref],
  ];
  if (appt.price_cents != null) {
    rows.splice(1, 0, ['Price', `$${(appt.price_cents / 100).toFixed(2)}`]);
  }
  return rows;
}

/**
 * Every one of these takes the tenant now rather than just a timezone.
 *
 * The line that made this urgent was "Your appointment at Synergy Salon is
 * confirmed", which every shop's guests would have received.
 */
/**
 * The welcome a new team member gets the moment they are added.
 *
 * Everything they need in one place, because the person who added them is
 * often not beside them when they open it: the link that sets them up, where
 * the app lives afterwards, what to fill in on their own account, and how to
 * put their calendar on Appt. Book. No password is ever in it: there is none
 * to send, since they choose it themselves through the link, which is the
 * only credential here and says plainly how long it lasts and not to forward
 * it.
 */
export function welcomeContent({ name, email, link, appUrl, expiresDays }, shop) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  return {
    subject: `Welcome to the ${shop.name} team: set up your account`,
    content: {
      heading: `Welcome to the team, ${first}`,
      intro: `You have been added to the ${shop.name} app, where the team keeps the `
        + 'appointment book, clients and their own calendars. Setting up takes a few minutes.',
      rows: [['Your sign-in email', email], ['The app', appUrl]],
      action: { label: 'Set up your account', href: link },
      steps: {
        title: 'Getting started',
        items: [
          {
            title: 'Choose your password',
            text: `Use the button above. It signs you straight in. The link works once `
              + `and expires in ${expiresDays} days.`,
          },
          {
            title: 'Sign in any time after that',
            text: `Go to ${appUrl} and sign in with ${email} and the password you chose.`,
          },
          {
            title: 'Complete your Team Settings',
            text: 'Open Settings, then Team, and click your own name. Add your photo, a username, '
              + 'your phone number, and switch on the services you do with your price for each. '
              + 'The owner sets your weekly hours.',
          },
          {
            title: 'Connect your calendar',
            text: 'In the same window, under Connect your tools, choose Google Calendar. Paste your '
              + 'calendar\u2019s secret address (in Google Calendar: Settings, your calendar, '
              + 'Integrate calendar, "Secret address in iCal format"), or sign in with Google if '
              + 'that option is shown. Your busy times then appear on Appt. Book, so nobody books '
              + 'you when you are away. Only the times are read, never what the events are.',
          },
        ],
      },
      footnote: 'The setup link is just for you: anyone who has it can set up your account, so '
        + 'please do not forward it. If it has expired, ask the owner to send a new one.',
    },
  };
}

/** The welcome as it will be sent, for a preview or a test. */
export function welcomeEmail(args, tenant = {}) {
  const shop = shopFrom(tenant);
  const { subject, content } = welcomeContent(args, shop);
  return { subject, html: layout(content, shop), text: plain(content, shop) };
}

export function sendInvite({ name, email, link, appUrl, expiresDays }, tenant = {}) {
  const shop = shopFrom(tenant);
  // The app's own address: app.synergysalon.com opens the console at its
  // root, and any other host (a preview, localhost) serves it under /staff.
  const u = new URL(link);
  const app = appUrl || (u.hostname.startsWith('app.') ? u.origin : `${u.origin}/staff`);
  const { subject, content } = welcomeContent({ name, email, link, appUrl: app, expiresDays }, shop);
  return send(shop, email, subject, content);
}

/**
 * Each guest message as data: its subject and what goes in it.
 *
 * Kept apart from sending so the staff app can show the very message a guest
 * receives (Marketing, Automation) rather than a description of it that
 * drifts the first time the wording here changes.
 */
const MESSAGES = {
  confirmation: (appt, shop, zone) => ({
    subject: `You are booked in: ${prettyWhen(appt.starts_at, zone)}`,
    content: {
      heading: `See you soon, ${appt.guest_name.split(' ')[0]}`,
      intro: `Your appointment at ${shop.name} is confirmed. Here are the details.`,
      rows: detailRows(appt, zone),
      action: { label: 'Reschedule or cancel', href: manageUrl(shop, appt.ref, appt.manage_token) },
      footnote: 'If you need to change anything, use the link above or call us. '
        + 'Please let us know at least 24 hours ahead so we can offer the slot to someone else.',
    },
  }),
  reschedule: (appt, shop, zone, previousStart) => ({
    subject: `Moved: you are now booked for ${prettyWhen(appt.starts_at, zone)}`,
    content: {
      heading: 'Your appointment has moved',
      intro: `You were booked for ${prettyWhen(previousStart, zone)}. That is now cancelled and `
        + 'you are booked in at the new time below.',
      rows: detailRows(appt, zone),
      action: { label: 'Reschedule or cancel', href: manageUrl(shop, appt.ref, appt.manage_token) },
    },
  }),
  cancellation: (appt, shop, zone) => ({
    subject: `Cancelled: ${prettyWhen(appt.starts_at, zone)}`,
    content: {
      heading: 'Your appointment is cancelled',
      intro: 'We have cancelled the appointment below and released the slot. '
        + 'We would love to see you another time.',
      rows: detailRows(appt, zone),
      action: shop.site ? { label: 'Book again', href: shop.site } : undefined,
    },
  }),
  reminder: (appt, shop, zone) => ({
    subject: `Tomorrow: ${prettyWhen(appt.starts_at, zone)}`,
    content: {
      heading: 'See you tomorrow',
      intro: `A quick reminder about your appointment at ${shop.name}.`,
      rows: detailRows(appt, zone),
      action: { label: 'Reschedule or cancel', href: manageUrl(shop, appt.ref, appt.manage_token) },
      footnote: 'If you cannot make it, please tell us as soon as you can so we can offer '
        + 'the slot to someone else.',
    },
  }),
};

export const MESSAGE_KINDS = Object.keys(MESSAGES);

function sendMessage(kind, appt, tenant, extra) {
  const shop = shopFrom(tenant);
  const { subject, content } = MESSAGES[kind](appt, shop, shop.timezone, extra);
  return send(shop, appt.guest_email, subject, content);
}

export function sendConfirmation(appt, tenant = {}) { return sendMessage('confirmation', appt, tenant); }
export function sendReschedule(appt, previousStart, tenant = {}) { return sendMessage('reschedule', appt, tenant, previousStart); }
export function sendCancellation(appt, tenant = {}) { return sendMessage('cancellation', appt, tenant); }
export function sendReminder(appt, tenant = {}) { return sendMessage('reminder', appt, tenant); }

/**
 * A message exactly as it would go out, without sending it: same subject,
 * same HTML, same sender. The appointment is whatever the caller supplies,
 * usually a sample, since a preview must not need a real guest.
 */
export function previewMessage(kind, appt, tenant = {}, extra) {
  if (!MESSAGES[kind]) return null;
  const shop = shopFrom(tenant);
  const { subject, content } = MESSAGES[kind](appt, shop, shop.timezone, extra);
  return {
    from: fromFor(shop),
    replyTo: shop.replyTo || null,
    subject,
    html: layout(content, shop),
    text: plain(content, shop),
  };
}
