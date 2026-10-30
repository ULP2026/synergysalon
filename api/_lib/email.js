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

import { DEFAULT_TZ, shopFrom } from './config.js';
// Safe to import without a database: db.js builds its pool lazily, so the
// template functions and previewMessage still work with no DATABASE_URL.
import { query } from './db.js';
import { textGuest } from './sms-notify.js';

const senderAddress = (v) => { const m = String(v).match(/<([^>]+)>/); return (m ? m[1] : String(v)).trim(); };

/**
 * Who the message is from: noreply@synergysalon.com, for every email the
 * app sends, guests' and the team's alike (asked for 2026-10-15; it used to
 * be bookings@). FROM_EMAIL overrides.
 *
 * One address for every shop, because the sending domain has to be one
 * verified with the provider -- a shop's own address in the From header is
 * what gets the whole platform marked as spam. The shop's name still leads
 * it, so a guest sees who is writing, and replies go to the shop itself.
 *
 * Resend refuses any domain not verified with it, and the one verified is
 * BOOKING_FROM_EMAIL's (noreply.synergysalon.com). Until synergysalon.com
 * itself is verified there, a refusal is retried from noreply@ on that
 * domain (FALLBACK) rather than the email being lost: a confirmation that
 * never arrives is worse than one from the longer address.
 */
const SENDER = process.env.FROM_EMAIL || 'noreply@synergysalon.com';
const VERIFIED = senderAddress(process.env.BOOKING_FROM_EMAIL || 'bookings@synergysalon.com');
const FALLBACK = `noreply@${VERIFIED.split('@')[1] || 'synergysalon.com'}`;

function fromFor(shop, sender = SENDER) {
  return `${shop.name} <${senderAddress(sender)}>`;
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

/**
 * "1 hour 30 minutes", "45 minutes" -- how long to set aside.
 *
 * Returns an empty string for anything that is not a positive number of
 * minutes, and every caller checks, because a row reading "Plan for about
 * undefined" is worse than no row at all.
 */
export function prettyDuration(min) {
  const m = Number(min);
  if (!Number.isFinite(m) || m <= 0) return '';
  const hours = Math.floor(m / 60);
  const rest = Math.round(m % 60);
  const parts = [];
  if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (rest) parts.push(`${rest} minutes`);
  return parts.join(' ');
}

/**
 * "Add to my calendar", as a Google Calendar link.
 *
 * A link, not an .ics attachment: an attachment needs somewhere to serve the
 * file from and a twelfth serverless function to do it, and Vercel's Hobby
 * plan allows twelve in total. This costs nothing, works on a phone, and the
 * guest's own calendar app takes it from there.
 *
 * Google wants both ends in UTC basic format. The end is the start plus the
 * service's own duration; without one there is nothing honest to put, so the
 * caller leaves the link out rather than inventing an hour.
 */
export function calendarUrl(appt, shop, zone = DEFAULT_TZ) {
  const minutes = Number(appt.duration_min);
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  const start = DateTime.fromJSDate(new Date(appt.starts_at)).toUTC();
  const stamp = (d) => d.toFormat("yyyyLLdd'T'HHmmss'Z'");
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: `${appt.service_name} at ${shop.name}`,
    dates: `${stamp(start)}/${stamp(start.plus({ minutes }))}`,
    // No booking reference (2026-10-23): guests never need it, and the
    // confirmation's main button is now this calendar entry.
    details: `With ${appt.stylist_name}.`,
    location: shop.addressLines.join(', '),
    ctz: zone,
  });
  return `https://calendar.google.com/calendar/render?${p}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * The salon's colours, as the site uses them.
 *
 * Inline styles only, and no stylesheet: Gmail strips <style> from the head,
 * so anything not written on the element itself is lost on the client most
 * guests read this in.
 */
const INK = '#1E1F5C';
const BRAND = '#5560A6';
const TINT = '#E6E8F7';
const MUTED = '#6E6E85';
const PAPER = '#F4F5FA';

function layout({ heading, intro, rows, action, secondary, where, change, steps, footnote }, shop) {
  const cells = rows
    .map(([label, value]) => `
      <tr>
        <td style="padding:7px 16px 7px 0;color:${MUTED};font-size:14px;">${escapeHtml(label)}</td>
        <td style="padding:7px 0;color:${INK};font-size:14px;font-weight:600;white-space:pre-line;">${escapeHtml(value)}</td>
      </tr>`)
    .join('');

  const button = action
    ? `<p style="margin:28px 0 0;">
         <a href="${action.href}" style="background:${BRAND};color:#ffffff;text-decoration:none;
            padding:13px 24px;border-radius:999px;font-weight:600;font-size:15px;display:inline-block;">
           ${escapeHtml(action.label)}
         </a>
       </p>`
    : '';

  // A quieter second link under the button -- "Add to my calendar" today.
  // A plain link, not a second pill: two buttons of equal weight make a
  // guest choose, and the one that matters is the first.
  const extra = secondary
    ? `<p style="margin:14px 0 0;">
         <a href="${escapeHtml(secondary.href)}" style="color:${BRAND};font-size:14px;">
           ${escapeHtml(secondary.label)}
         </a>
       </p>`
    : '';

  // Under the button: where the salon is, then how to change the booking,
  // with the manage link on "this link" and the number tappable. Asked for
  // on the booking confirmation, 2026-10-23.
  const whereLine = where
    ? `<p style="margin:24px 0 0;color:#4A4A57;font-size:14px;line-height:1.55;">${escapeHtml(where)}</p>`
    : '';
  const changeLine = change
    ? `<p style="margin:12px 0 0;color:#4A4A57;font-size:14px;line-height:1.55;">
         Need to change something? Use
         <a href="${escapeHtml(change.href)}" style="color:${BRAND};font-weight:600;">this link</a>
         or ${change.phone
           ? `call us at <a href="${escapeHtml(change.phoneHref)}" style="color:${BRAND};font-weight:600;text-decoration:none;">${escapeHtml(change.phone)}</a>`
           : 'give us a call'}.
       </p>`
    : '';

  // Numbered instructions, for the one message that has any: the welcome.
  const list = steps && steps.items && steps.items.length
    ? `<h2 style="margin:32px 0 4px;font-size:16px;color:${INK};">${escapeHtml(steps.title || 'What to do next')}</h2>
       <ol style="margin:0;padding:0 0 0 20px;color:#4A4A57;font-size:14px;line-height:1.6;">
         ${steps.items.map((it) => `<li style="margin:10px 0 0;"><b style="color:${INK};">${escapeHtml(it.title)}</b><br>${escapeHtml(it.text)}</li>`).join('')}
       </ol>`
    : '';

  // The wordmark, linked to the salon's own site. Width and height are set as
  // attributes as well as in the style, because Outlook ignores the style and
  // would otherwise draw it at its full 363px.
  const mark = shop.logo
    ? `<p style="margin:0 0 24px;">
         <a href="${shop.site}"><img src="${shop.logo}" alt="${escapeHtml(shop.name)}"
            width="150" height="38" style="width:150px;height:auto;border:0;display:block;"></a>
       </p>`
    : `<p style="margin:0 0 24px;font-size:17px;font-weight:700;color:${INK};letter-spacing:.01em;">
         ${escapeHtml(shop.name)}
       </p>`;

  // The charset is declared in the document as well as the MIME headers: a
  // client that reads only the body guesses windows-1252 otherwise, and every
  // curly apostrophe in the copy arrives as "a€™".
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:${PAPER};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 16px;">
    <div style="background:#ffffff;border:1px solid ${TINT};border-radius:16px;padding:32px 28px;">
      ${mark}
      <h1 style="margin:0 0 8px;font-size:22px;line-height:1.3;color:${INK};">${escapeHtml(heading)}</h1>
      <p style="margin:0 0 24px;color:#4A4A57;font-size:15px;line-height:1.55;">${escapeHtml(intro)}</p>
      <table style="border-collapse:collapse;">${cells}</table>
      ${button}
      ${extra}
      ${whereLine}
      ${changeLine}
      ${list}
      ${footnote ? `<p style="margin:28px 0 0;color:${MUTED};font-size:13px;line-height:1.55;">${escapeHtml(footnote)}</p>` : ''}
      <hr style="border:none;border-top:1px solid ${TINT};margin:28px 0 16px;">
      <p style="margin:0;color:${MUTED};font-size:13px;line-height:1.6;">
        ${escapeHtml(shop.name)}<br>
        ${shop.addressLines.map(escapeHtml).join('<br>')}${shop.addressLines.length ? '<br>' : ''}
        ${shop.phone ? `<a href="${shop.phoneHref}" style="color:${BRAND};text-decoration:none;">${escapeHtml(shop.phone)}</a>` : ''}
      </p>
    </div>
  </div>
</body></html>`;
}

function plain({ heading, intro, rows, action, secondary, where, change, steps, footnote }, shop) {
  return [
    heading,
    '',
    intro,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    ...(action ? ['', `${action.label}: ${action.href}`] : []),
    ...(secondary ? [`${secondary.label}: ${secondary.href}`] : []),
    ...(where ? ['', where] : []),
    ...(change ? [`Need to change something? Use this link: ${change.href}${
      change.phone ? ` or call us at ${change.phone}` : ' or give us a call'}.`] : []),
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
  const message = {
    from: fromFor(shop),
    replyTo: shop.replyTo || undefined,
    to,
    subject,
    html: layout(content, shop),
    text: plain(content, shop),
  };
  let { error } = await resend.emails.send(message);
  if (error && senderAddress(SENDER) !== FALLBACK) {
    console.warn(`Resend refused ${senderAddress(SENDER)} (${error.message}); sending from ${FALLBACK}`);
    ({ error } = await resend.emails.send({ ...message, from: fromFor(shop, FALLBACK) }));
  }
  if (error) throw new Error(`Resend refused the message: ${error.message}`);
  return { sent: true };
}

/** "Maria" out of "Maria Lopez", and "there" out of nothing at all. */
function first(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'there';
}

function detailRows(appt, zone) {
  // No Reference row (asked for 2026-10-23 on the confirmation, 2026-10-24 on
  // every email): guests never need it, since the manage link carries the
  // booking itself. Staff see it only in a client's contact details.
  const rows = [
    ['Service', appt.service_name],
    ['With', appt.stylist_name],
    ['When', prettyWhen(appt.starts_at, zone)],
  ];
  if (appt.price_cents != null) {
    rows.splice(1, 0, ['Price', `$${(appt.price_cents / 100).toFixed(2)}`]);
  }
  // How long to set aside, under the time, because "2:30 PM" alone has sent
  // more than one guest back to work before their colour was finished. Left
  // out entirely when the service has no duration on it.
  const howLong = prettyDuration(appt.duration_min);
  if (howLong) {
    rows.splice(rows.findIndex(([label]) => label === 'When') + 1, 0, ['How long', howLong]);
  }
  return rows;
}

/** The "add to my calendar" link as a secondary action, or nothing at all. */
function calUrl(appt, shop, zone) {
  const href = calendarUrl(appt, shop, zone);
  return href ? { label: 'Add to my calendar', href } : undefined;
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
              + 'that option is shown. Your busy times then appear on Appointments, so nobody books '
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
  return { from: fromFor(shop), subject, html: layout(content, shop), text: plain(content, shop) };
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
 * A message from the website's contact form, to the salon's own inbox (the
 * reply-to set in Settings, else the salon's email). Replying answers the
 * guest, because their address is the reply-to. Not a guest message, so it
 * is not in MESSAGES, not logged in Email History and not switchable.
 */
export function sendContactNotice({ name, email, phone, message, consent }, tenant = {}) {
  const shop = shopFrom(tenant);
  const to = shop.replyTo;
  if (!to) return Promise.resolve({ skipped: true });
  const pretty = phone ? `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}` : 'Not given';
  return send({ ...shop, replyTo: email }, to, `New website message from ${name}`, {
    heading: 'New message from the website',
    intro: `${name} sent this through the contact form on your website. Reply to this email to answer them.`,
    rows: [
      ['Name', name],
      ['Email', email],
      ['Mobile', pretty],
      ['Texts', consent ? 'Agreed to appointment texts' : 'Did not agree to texts'],
      ['Message', message],
    ],
  });
}

/**
 * Karen asking for a person (karen-ai.js, alert_salon): a complaint, a
 * consultation, somebody who wants to talk to the salon. Goes to the same
 * inbox as client replies (the reply-to set in Settings, else the salon's
 * email), with the conversation so the team need not ask again. Not a guest
 * message, so not in MESSAGES or Email History.
 */
export function sendKarenAlert({ name, phone, known, reason, summary, transcript = [] }, tenant = {}) {
  const shop = shopFrom(tenant);
  const to = shop.replyTo;
  if (!to) return Promise.resolve({ skipped: true });
  const who = name || phone || 'A client';
  const said = transcript.slice(-10)
    .map((m) => `${m.role === 'user' ? (first(name) === 'there' ? 'Client' : first(name)) : 'Karen'}: ${m.text}`)
    .join('\n');
  return send(shop, to, `Karen needs you: ${who} (${reason})`, {
    heading: 'A client needs a person',
    intro: `${who} texted Karen, and Karen has handed this to you. Please call or text them back.`,
    rows: [
      ['Name', name || 'Not on file'],
      ['Mobile', phone || 'Unknown'],
      ['On file', known ? 'Yes, a client of the salon' : 'No, a new number'],
      ['Why', reason],
      ['Summary', summary],
      ...(said ? [['Conversation', said]] : []),
    ],
  });
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
      intro: 'You are all set. Here are your details.',
      rows: detailRows(appt, zone),
      // Add to my calendar is the button now (2026-10-23); changing the
      // booking is a link in the line under it. A service with no length
      // gets no calendar link, so it falls back to the change link rather
      // than to no button at all.
      action: calUrl(appt, shop, zone)
        || { label: 'Reschedule or cancel', href: manageUrl(shop, appt.ref, appt.manage_token) },
      where: shop.addressLines.length ? `We are at ${shop.addressLines.join(', ')}.` : '',
      change: {
        href: manageUrl(shop, appt.ref, appt.manage_token),
        phone: shop.phone,
        phoneHref: shop.phoneHref,
      },
      footnote: 'We just ask for at least 24 hours notice so we can offer the time to another guest.',
    },
  }),
  reschedule: (appt, shop, zone, previousStart) => ({
    subject: `Moved: you are now booked for ${prettyWhen(appt.starts_at, zone)}`,
    content: {
      heading: 'Your appointment has moved',
      // Every send knows the old time. Email history rebuilds a sent one from
      // the log, which does not keep it, and says the rest without it rather
      // than "1 January 1970".
      intro: previousStart
        ? `You were booked for ${prettyWhen(previousStart, zone)}. That is now cancelled and `
          + 'you are booked in at the new time below.'
        : 'Your earlier time is now cancelled and you are booked in at the new time below.',
      rows: detailRows(appt, zone),
      action: { label: 'Reschedule or cancel', href: manageUrl(shop, appt.ref, appt.manage_token) },
      // The old time is already in their calendar, so the new one has to be
      // offered here or they keep the wrong entry.
      secondary: calUrl(appt, shop, zone),
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
      intro: `A quick reminder about your appointment at ${shop.name}. `
        + 'Want to add a treatment while you are here? Olaplex, K18 and deep conditioning '
        + 'pair beautifully with colour, and there is usually time if you mention it when '
        + 'you arrive.',
      rows: detailRows(appt, zone),
      action: { label: 'Reschedule or cancel', href: manageUrl(shop, appt.ref, appt.manage_token) },
      footnote: 'If you cannot make it, please tell us as soon as you can so we can offer '
        + 'the slot to someone else.',
    },
  }),

  // ---- M4 to M11: queued rather than immediate (see scheduled.js) --------
  //
  // Each takes the same (appt, shop, zone) as the four above, so the queue can
  // render any of them without knowing which it holds. Where a module has
  // several touches they are separate kinds -- no_show_1, no_show_2 -- rather
  // than one template with a counter, because the queue stores the kind and
  // Marketing should count them apart.

  /** M4 New Guest Welcome: their first ever booking, shortly after it. */
  welcome_new: (appt, shop, zone) => ({
    subject: `Your first visit to ${shop.name}`,
    content: {
      heading: `Welcome, ${first(appt.guest_name)}`,
      intro: 'We are looking forward to meeting you. Here is what to expect on your first visit, '
        + 'so none of it is a surprise.',
      rows: detailRows(appt, zone),
      action: { label: 'Reschedule or cancel', href: manageUrl(shop, appt.ref, appt.manage_token) },
      secondary: calUrl(appt, shop, zone),
      steps: {
        title: 'Before you come',
        items: [
          {
            title: 'Arrive a few minutes early',
            text: 'There is free parking outside, and it gives us time to talk properly before we start.',
          },
          {
            title: 'Bring photos if you have them',
            text: 'Pictures of what you like, and of colour you have had before, tell us more than words do.',
          },
          {
            title: 'Tell us your hair history',
            text: 'Box colour, bleach, keratin, anything in the last year. It changes what is safe to '
              + 'do, and we would rather know before anything is mixed.',
          },
        ],
      },
      footnote: `Any questions before you come, call us${shop.phone ? ` on ${shop.phone}` : ''}.`,
    },
  }),

  /** M5 No-Show Recovery, first touch. */
  no_show_1: (appt, shop, zone) => ({
    subject: 'We missed you today',
    content: {
      heading: `We missed you, ${first(appt.guest_name)}`,
      intro: 'You were booked in with us today and we did not see you. No hard feelings, things '
        + 'come up. Would you like to find another time?',
      rows: detailRows(appt, zone),
      action: shop.site ? { label: 'Book another time', href: shop.site } : undefined,
      footnote: 'If something went wrong at our end we would genuinely like to know. '
        + `Call us${shop.phone ? ` on ${shop.phone}` : ''} and tell us.`,
    },
  }),

  /** M5 second touch, a few days later. */
  no_show_2: (appt, shop) => ({
    subject: 'Still happy to see you',
    content: {
      heading: 'Your chair is still here',
      intro: `We had ${appt.service_name} held for you with ${appt.stylist_name}. Whenever you are `
        + 'ready, we will find you another time.',
      rows: [],
      action: shop.site ? { label: 'Pick a new time', href: shop.site } : undefined,
    },
  }),

  /** M6 Late Cancellation: inside 24 hours, so the slot could not be refilled. */
  late_cancel: (appt, shop, zone) => ({
    subject: 'Your appointment is cancelled',
    content: {
      heading: `Thanks for letting us know, ${first(appt.guest_name)}`,
      intro: 'We have cancelled the appointment below. Cancellations this close to the time are '
        + 'hard for us to fill, so as much notice as you can give really helps. No charge either way.',
      rows: detailRows(appt, zone),
      action: shop.site ? { label: 'Book another time', href: shop.site } : undefined,
    },
  }),

  /** M7 Post-Visit Check-In, the same day. */
  post_visit: (appt, shop) => ({
    subject: 'How do you love it?',
    content: {
      heading: `How is it looking, ${first(appt.guest_name)}?`,
      intro: `You were in with ${appt.stylist_name}. We would love to know how you are getting on `
        + 'with it now you have lived in it a little.',
      rows: [],
      action: shop.phone ? { label: 'Tell us', href: shop.phoneHref } : undefined,
      footnote: 'If anything is not right, say so and we will put it right. We would much rather '
        + 'hear it from you than not hear it at all.',
    },
  }),

  /** M7 second touch: aftercare. */
  aftercare: (appt, shop) => ({
    subject: 'Making it last',
    content: {
      heading: 'Looking after it',
      intro: 'A few things that keep colour and condition looking the way they did when you left.',
      rows: [],
      steps: {
        title: 'The short version',
        items: [
          {
            title: 'Wait 48 hours before washing',
            text: 'Colour is still settling. Washing it too soon is the quickest way to lose it.',
          },
          {
            title: 'Cooler water, gentler shampoo',
            text: 'Hot water opens the cuticle and lifts colour out. Sulphate-free keeps it in.',
          },
          {
            title: 'Heat protection every time',
            text: 'Before straighteners or a dryer, without exception. It is the difference between '
              + 'hair that lasts and hair that snaps.',
          },
        ],
      },
      footnote: 'Ask us next time about Olaplex, K18 or deep conditioning if you would like it to '
        + 'hold longer between visits.',
    },
  }),

  /** M8 Review Request, after a visit with no open issue. */
  review_ask: (appt, shop) => ({
    subject: `How did we do, ${first(appt.guest_name)}?`,
    content: {
      heading: 'Would you tell someone else?',
      intro: `If you were happy with ${appt.stylist_name}, a short review helps other people in `
        + 'Valrico find us. It takes about a minute and it makes a real difference to a salon our size.',
      rows: [],
      action: shop.reviewUrl ? { label: 'Leave a review', href: shop.reviewUrl } : undefined,
      footnote: 'If anything was less than you hoped for, reply to this instead and we will sort it.',
    },
  }),

  /** M9 Rebook: the service is about due and nothing is in the diary. */
  rebook_due: (appt, shop) => ({
    subject: 'Time for a refresh?',
    content: {
      heading: `Due about now, ${first(appt.guest_name)}`,
      intro: `It has been a while since your ${appt.service_name} with ${appt.stylist_name}. To keep `
        + 'it looking the way it did, now is about the right time.',
      rows: [],
      action: shop.site ? { label: 'Book your next visit', href: shop.site } : undefined,
    },
  }),

  /** M10 New Guest Second Visit: first visit done, nothing booked since. */
  second_visit: (appt, shop) => ({
    subject: 'Come back and see us',
    content: {
      heading: `Thanks for trying us, ${first(appt.guest_name)}`,
      intro: `We hope you liked what ${appt.stylist_name} did. The second visit is when a stylist `
        + 'really starts to know your hair, so we would love to see you again.',
      rows: [],
      action: shop.site ? { label: 'Book again', href: shop.site } : undefined,
    },
  }),

  /** M11 Lapsed Guest Win-Back: nobody has seen them in a long time. */
  win_back: (appt, shop) => ({
    subject: 'It has been a while',
    content: {
      heading: `We have missed you, ${first(appt.guest_name)}`,
      intro: 'It has been a while since we saw you at the salon. Nothing to read into it, we just '
        + 'wanted to say the chair is still here whenever you want it.',
      rows: [],
      action: shop.site ? { label: 'Book a time', href: shop.site } : undefined,
      footnote: 'If you have found somewhere you like better that is completely fine and you can '
        + 'ignore this. If something put you off, we would really like to know what.',
    },
  }),
};

export const MESSAGE_KINDS = Object.keys(MESSAGES);

/**
 * Whether this salon has switched an automation off, from Marketing.
 *
 * Off rather than on, so a salon that has never touched the switches has
 * everything running, and a message kind added later is on by default rather
 * than silently dark. A tenant row loaded before migration 024 has no column
 * at all, which reads as undefined and therefore as on.
 */
export function automationOn(kind, tenant = {}) {
  const off = tenant.automations_off;
  return !(Array.isArray(off) && off.includes(kind));
}

/**
 * Write down that a guest was emailed.
 *
 * Best-effort, like the sending itself: the message has already left, and
 * failing the caller because a log row would not insert would turn a
 * delivered confirmation into a 500 and, upstream, a lost booking. A missing
 * table (migration 024 not yet run against this database) lands here too,
 * which is deliberate -- the feature is a count on a page, and it is not
 * worth taking the booking path down for.
 */
async function record(kind, appt, tenant) {
  if (!tenant?.id) return;
  try {
    await query(
      `INSERT INTO message_sends (tenant_id, kind, appointment_id, to_name, to_email)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenant.id, kind, appt.id ?? null, appt.guest_name ?? null, appt.guest_email],
    );
  } catch (err) {
    console.warn('message_sends insert failed', kind, err.message);
  }
}

async function sendMessage(kind, appt, tenant, extra) {
  const shop = shopFrom(tenant);
  if (!automationOn(kind, tenant)) return { skipped: true, off: true };
  // The text of the same kind, to a client who agreed to texts (sms-notify.js).
  // First, and never throwing, so a guest with no email still gets it and a
  // refused email does not stop it.
  const texted = await textGuest(kind, appt, tenant);
  if (!appt.guest_email) return { skipped: true, noEmail: true, texted: Boolean(texted.texted) };
  const { subject, content } = MESSAGES[kind](appt, shop, shop.timezone, extra);
  const out = await send(shop, appt.guest_email, subject, content);
  if (out.sent) await record(kind, appt, tenant);
  return out;
}

/**
 * Send any message kind by name, for the queue (scheduled.js), which holds
 * the kind as data and cannot call a named helper per module.
 *
 * Goes through sendMessage like everything else, so a queued message obeys
 * the same switch and is logged the same way as an immediate one.
 */
export function sendKind(kind, appt, tenant = {}, extra) {
  if (!MESSAGES[kind]) return Promise.resolve({ skipped: true, unknown: true });
  return sendMessage(kind, appt, tenant, extra);
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
