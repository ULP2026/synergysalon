/**
 * Everything about the booking system that a person might reasonably want to
 * change without reading the rest of the code.
 */

/** The salon's wall clock. Slots are generated in this zone, stored as UTC. */
export const SALON_TZ = 'America/New_York';

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

/** Public site, used to build links in emails. */
export const SITE_URL = process.env.SITE_URL || 'https://synergysalon.com';

export const SALON = {
  name: 'Synergy Salon',
  phone: '(813) 654-2055',
  phoneHref: 'tel:+18136542055',
  email: 'hair@synergysalon.com',
  addressLines: ['3212 Lithia Pinecrest Rd, Suite 101', 'Valrico, FL 33594'],
};

/**
 * Ref codes a guest reads down the phone. No O/0 or I/1, because they are
 * always misheard, and no vowels, because random strings that spell words
 * are a support problem.
 */
export const REF_ALPHABET = '23456789BCDFGHJKLMNPQRSTVWXYZ';
export const REF_LENGTH = 6;
