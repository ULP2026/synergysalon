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

import { SALON, SALON_TZ, SITE_URL } from './config.js';

const FROM = process.env.BOOKING_FROM_EMAIL || 'Synergy Salon <hair@synergysalon.com>';

function client() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (!globalThis.__synergyResend) globalThis.__synergyResend = new Resend(key);
  return globalThis.__synergyResend;
}

export function manageUrl(ref, token) {
  return `${SITE_URL}/appointment?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(token)}`;
}

/** "Wednesday 1 October 2026 at 2:30 PM" — unambiguous, no numeric dates. */
export function prettyWhen(startsAt) {
  return DateTime.fromJSDate(new Date(startsAt))
    .setZone(SALON_TZ)
    .toFormat("cccc d LLLL yyyy 'at' h:mm a");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function layout({ heading, intro, rows, action, footnote }) {
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

  return `<!doctype html>
<html lang="en"><body style="margin:0;background:#faf8f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px;">
    <h1 style="margin:0 0 8px;font-size:22px;color:#1b1b1b;">${escapeHtml(heading)}</h1>
    <p style="margin:0 0 24px;color:#4a4a4a;font-size:15px;line-height:1.55;">${escapeHtml(intro)}</p>
    <table style="border-collapse:collapse;">${cells}</table>
    ${button}
    ${footnote ? `<p style="margin:28px 0 0;color:#6b6b6b;font-size:13px;line-height:1.55;">${escapeHtml(footnote)}</p>` : ''}
    <hr style="border:none;border-top:1px solid #e8e2dc;margin:28px 0 16px;">
    <p style="margin:0;color:#6b6b6b;font-size:13px;line-height:1.6;">
      ${escapeHtml(SALON.name)}<br>
      ${SALON.addressLines.map(escapeHtml).join('<br>')}<br>
      <a href="${SALON.phoneHref}" style="color:#6b6b6b;">${escapeHtml(SALON.phone)}</a>
    </p>
  </div>
</body></html>`;
}

function plain({ heading, intro, rows, action, footnote }) {
  return [
    heading,
    '',
    intro,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    ...(action ? ['', `${action.label}: ${action.href}`] : []),
    ...(footnote ? ['', footnote] : []),
    '',
    SALON.name,
    ...SALON.addressLines,
    SALON.phone,
  ].join('\n');
}

async function send(to, subject, content) {
  const resend = client();
  if (!resend) {
    console.warn('RESEND_API_KEY is not set; skipping email to', to);
    return { skipped: true };
  }
  const { error } = await resend.emails.send({
    from: FROM,
    to,
    subject,
    html: layout(content),
    text: plain(content),
  });
  if (error) throw new Error(`Resend refused the message: ${error.message}`);
  return { sent: true };
}

function detailRows(appt) {
  const rows = [
    ['Service', appt.service_name],
    ['With', appt.stylist_name],
    ['When', prettyWhen(appt.starts_at)],
    ['Reference', appt.ref],
  ];
  if (appt.price_cents != null) {
    rows.splice(1, 0, ['Price', `$${(appt.price_cents / 100).toFixed(2)}`]);
  }
  return rows;
}

export function sendConfirmation(appt) {
  return send(appt.guest_email, `You are booked in — ${prettyWhen(appt.starts_at)}`, {
    heading: `See you soon, ${appt.guest_name.split(' ')[0]}`,
    intro: 'Your appointment at Synergy Salon is confirmed. Here are the details.',
    rows: detailRows(appt),
    action: { label: 'Reschedule or cancel', href: manageUrl(appt.ref, appt.manage_token) },
    footnote: 'If you need to change anything, use the link above or call us. '
      + 'Please let us know at least 24 hours ahead so we can offer the slot to someone else.',
  });
}

export function sendReschedule(appt, previousStart) {
  return send(appt.guest_email, `Moved — you are now booked for ${prettyWhen(appt.starts_at)}`, {
    heading: 'Your appointment has moved',
    intro: `You were booked for ${prettyWhen(previousStart)}. That is now cancelled and `
      + 'you are booked in at the new time below.',
    rows: detailRows(appt),
    action: { label: 'Reschedule or cancel', href: manageUrl(appt.ref, appt.manage_token) },
  });
}

export function sendCancellation(appt) {
  return send(appt.guest_email, `Cancelled — ${prettyWhen(appt.starts_at)}`, {
    heading: 'Your appointment is cancelled',
    intro: 'We have cancelled the appointment below and released the slot. '
      + 'We would love to see you another time.',
    rows: detailRows(appt),
    action: { label: 'Book again', href: `${SITE_URL}/book` },
  });
}

export function sendReminder(appt) {
  return send(appt.guest_email, `Tomorrow — ${prettyWhen(appt.starts_at)}`, {
    heading: 'See you tomorrow',
    intro: 'A quick reminder about your appointment at Synergy Salon.',
    rows: detailRows(appt),
    action: { label: 'Reschedule or cancel', href: manageUrl(appt.ref, appt.manage_token) },
    footnote: 'If you cannot make it, please tell us as soon as you can so we can offer '
      + 'the slot to someone else.',
  });
}
