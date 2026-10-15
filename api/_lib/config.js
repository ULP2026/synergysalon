/**
 * Everything about the booking system that a person might reasonably want to
 * change without reading the rest of the code.
 */

/**
 * Fallback wall clock, used only where no tenant is in hand (a stray cron
 * row, a test). Real requests take the timezone from tenants.timezone,
 * because the second salon will not be in Florida.
 */
export const DEFAULT_TZ = 'America/New_York';

/**
 * Whether guests may book themselves in from the website.
 *
 * Off. It was first turned off on 30 September because the public calendar
 * offered 9 AM with stylists who do not start then and guests took it. It was
 * opened on 15 October and closed again the same day: the booking side works
 * end to end, but the only people bookable were Rj Cervantes and a test
 * account, the four stylists the website shows had nothing set up, and the
 * salon would rather guests called than met a team of two.
 *
 * So this is now waiting on the salon, not on the code. The go-live checklist
 * below says what is left; the short version is the four stylists' services
 * and hours, set by the admin from Team.
 *
 * The site shows "Online appointments are coming soon" and a phone number
 * instead, and the server refuses online bookings as well, so a page cached
 * from before cannot slip one through. Leads are still saved as contacts and
 * staff bookings in the console are unaffected. This flag and the website's
 * `ss-booking-paused` block move together: one without the other either walks
 * a guest through the whole survey before refusing them, or lets a cached
 * page through.
 */
export const ONLINE_BOOKING = false;

/**
 * Stylists offered online without a Google Calendar connected, by salon.
 * Everybody else needs one before guests see them (google-busy.js), but the
 * salon asked that its four current stylists stay bookable meanwhile, from
 * their hours in the Synergy Calendar, and connect their calendars later.
 * Once one of them connects, their Google busy time is taken out as for
 * anybody else. Matched on the stylist's slug, which never changes.
 */
export const GOOGLE_OPTIONAL_STYLISTS = {
  synergy: ['dina', 'micah', 'tami', 'kim'],
};

/**
 * Logins that may open and change other team members' accounts, as well as
 * the salon's owners. This is the agency that runs the app for the salon, so
 * it can set people up and help them without being made an owner. Matched on
 * the sign-in email, within whichever salon the login belongs to.
 */
export const TEAM_ADMIN_EMAILS = ['support@unclelouieproductions.com'];

/** Slots are offered on this grid: 09:00, 09:15, 09:30 ... */
export const SLOT_STEP_MIN = 15;

/**
 * How soon someone may book. Two hours means nobody books a colour service
 * for ten minutes from now while the stylist is mid-appointment and unable to
 * see her phone.
 */
export const MIN_LEAD_MIN = 120;

/** How far ahead the calendar opens. Beyond this the diary is not yet real. */
export const MAX_ADVANCE_DAYS = 90;

/**
 * How far ahead the reminder job looks.
 *
 * Wider than "24 hours" on purpose: Vercel's Hobby plan runs a cron once a
 * day, so one pass at 10am has to cover everyone booked tomorrow, including
 * the 7pm Thursday appointments. Each appointment is still only reminded
 * once, because sending is recorded against the row. On a plan that allows
 * an hourly cron, narrow this to 24 and the reminders land closer to the day.
 */
export const REMINDER_LEAD_HOURS = 36;

/**
 * Where a guest manages their booking, when the shop has no domain of its own.
 *
 * A shop that has pointed a domain here gets links on that domain instead; see
 * shopFrom() below, which prefers the tenant's own host.
 */
export const SITE_URL = process.env.SITE_URL || '';

/**
 * The shop as a guest sees it, taken from the tenant row.
 *
 * This used to be a constant holding one salon's name, phone number and
 * address, which was true while there was one salon. Left that way, the second
 * shop's guests get a confirmation email for a salon in Valrico they have
 * never heard of. Nothing about a shop belongs in the code.
 */
export function shopFrom(tenant = {}) {
  const site = tenant.host ? `https://${tenant.host}`
    : (SITE_URL || (tenant.slug ? `/s/${tenant.slug}` : ''));
  const digits = String(tenant.phone || '').replace(/[^\d+]/g, '');
  return {
    name: tenant.name || 'the salon',
    phone: tenant.phone || '',
    phoneHref: digits ? `tel:${digits}` : '',
    email: tenant.email || '',
    // Where a guest's reply lands: the inbox set in Team Settings, else the
    // address the salon publishes.
    replyTo: tenant.reply_to || tenant.email || '',
    // One line per line the owner typed, so a shop that writes its address on
    // one line is not split into invented ones.
    addressLines: String(tenant.address || '').split(/\s*\n\s*/).filter(Boolean),
    // Only a hosted logo reaches an email: Gmail and Outlook drop <img> whose
    // src is a data: URI, and a shop that uploaded one gets a broken image
    // rather than none, which looks worse than a plain wordmark.
    logo: /^https?:\/\//i.test(String(tenant.logo || '')) ? tenant.logo : '',
    site,
    timezone: tenant.timezone || DEFAULT_TZ,
  };
}

/**
 * Ref codes a guest reads down the phone. No O/0 or I/1, because they are
 * always misheard, and no vowels, because random strings that spell words
 * are a support problem.
 */
export const REF_ALPHABET = '23456789BCDFGHJKLMNPQRSTVWXYZ';
export const REF_LENGTH = 6;
