/**
 * What Karen in the app knows about the app itself (asked for 2026-10-31:
 * "I want Karen to actually know and understand the Synergy app, not just
 * pretend to know it").
 *
 * Written from what the app does, in the words the team sees on screen,
 * not from what it might do. When a screen, a rule or a setting changes,
 * change it here too, or Karen will explain the old one with confidence.
 * Anything that varies by salon or day (the team, the hours, which emails
 * are switched on) is not written here: she looks it up with her tools.
 */
import { CLIENT_PRICES, ONLINE_BOOKING, REMINDER_LEAD_HOURS } from './config.js';

export const APP_GUIDE = `HOW THE SYNERGY APP WORKS

The menu: Home, Appt. Book, Clients, Settings, and the "Call Karen" button (this chat).

Home
- A greeting, then two figures: salon appointments today and in the last 30 days (opens Appt. Book), and clients served in the last 30 days with how many were new (opens Clients).
- Charts the admin arranged, and "Coming up": the next six booked appointments; clicking one opens it on Appt. Book.
- Finance (owners, admins and managers only): what visits were worth in a period, by stylist. The app records no payments yet, so this is the booked value, not money received.

Appt. Book
- Day view: one column per team member who has connected their Google Calendar, headed with their role. A stylist who has not connected gets a column only on days they have a booking or block. Bookings with no stylist share an "Unassigned" column.
- Each column shows their bookings, their Google busy times, lunches and blocks. Time outside their working hours is hatched "Block · Not bookable" ("Starts 9 AM", "Done at 4 PM", "Not working today"). Time that has passed is greyed out. Neither can be clicked to book.
- Their flexible lunch shows as a dashed "Lunch · flexible" band where it currently falls.
- Click an empty time in someone's column to book with them. Lunch and Block can be added to a column; a block really stops that time being booked, online and at the desk, and is copied to their Google Calendar if they signed in with Google.
- A colour with a processing break shows its Start, a dashed "Processing · free" band (the stylist is free, and that time can be booked), and its Finish.
- Month view shows the bookings per day. The day reloads by itself every two minutes and when the tab comes back into focus.
- Clicking an appointment opens its window (the ticket): client, stylist, when, each service with quantity, time and price, the total, who booked it, payment ("Not recorded": the app takes no payments yet). Its buttons: Check in, No-show, Done, Cancel, Reopen (a cancelled one, if the time is still free) and Delete (owners, admins and managers only). There is no reschedule button for staff yet; the client can move their own appointment from the link in their emails.

New appointment (the "New appointment" button, or a click on Appt. Book)
- Five steps: stylist (or first available), kind of service (Color, Cuts, Treatments, Styling), the service, day and time, then the client.
- "Add another service" books several services as one visit with one stylist, end to end.
- The day and time step only offers times that really work: passed and taken times are struck through. The client step finds an existing client from the third letter typed, or takes a new one's name with a phone or email.
- "Help me book" in its header opens this chat with what has been chosen so far.

Clients
- The list, a search, and "Choose your stylist" (each client is grouped under whoever they last booked with). Each row's Book button books them with that stylist.
- A client's profile: contact details and Tags and status (New, Contacted, Booked, Client, Lost) edited with the pencils; notes (Add note puts a dated line on top); Contact preferences (Email and Text messages switches; turning email off stops follow-up emails, while confirmations, reminders and cancellations still go); Payments (the "Card on file" switch: a flag only, the app stores no card); their appointments; and Activity.
- Activity, with filters for Appointments, Email, SMS, Automations and Forms: every booking ("Booked by Karen", "Booked by <team member>", "Booked by Client (Website)"), check-ins, done, no-shows, cancellations, and every email sent to them with its subject, time and Sent or Failed.

Settings
- My Settings: your name and role, Edit my profile, Appearance (light, dark or match the device; per browser), Sign out.
- Salon: Salon Profile (name, address, phone, logo; the logo is the menu's mark) and "Where do you want people to reply to" (the reply-to address on every client email).
- Team: everyone on the team, each with Calendar and Payroll status (Connected or Disconnected). Only the admin adds people, changes anybody else's details, hours or role, or removes someone; everyone can read the team. Adding somebody emails them a one-time link to choose their own password. A stylist's mobile number is required (it is how Karen knows them by text).
- The team member window: picture (upload and crop, or choose an avatar), name and phone, email and role, Connect your tools (Google Calendar; Stripe for payroll is coming soon), Services & pricing (Cuts, Color, Treatments, Styling, each switched on with a price and a duration; Color and Highlights have Start, Break and Finish times; one box of notes for clients), and Working hours with the Lunch break switch. Working hours and the lunch switch are set by the admin only.
- Automations: the twelve automated emails, each with an On/Off switch (turning one off asks you to type its name), and Email History under them (open it from its header): every email sent, with search and a filter, Failed ones marked; clicking one shows the email as rebuilt from the booking now.
- Payments: Billing and Payroll, both coming soon (owners, admins and managers).
- Karen AI: Karen's phone number, which clients can call or text.

BOOKING RULES (true for the website, the desk, Karen and the client's own reschedule)
- A booking can only start inside the stylist's working hours and must finish by the end of them. A day with no hours is a day off.
- A booking is as long as that stylist says the work takes (their own durations in Services & pricing), else the service's standard length. Several services are one visit with one stylist who does them all, end to end, a cut first when there is colour.
- A colour's processing break frees the stylist: another short service can be booked into it.
- The flexible lunch: each stylist with the Lunch break switch on keeps 30 free minutes somewhere between 11:00 AM and 1:00 PM. It has no fixed place, so a booking can take the time it is in and the lunch moves, but no booking is offered that would leave no free half hour in that window. A lunch put on the grid by hand replaces it that day.
- Two clients can never be in the same chair at the same time: the database refuses a double booking.
- Online, a stylist is offered only once they have connected a Google Calendar, and their Google busy times are taken out. The salon's four original stylists (Dina, Micah, Tami and Kim) are offered from their hours until they connect. The desk is not limited by Google.
- Online booking on the website is ${ONLINE_BOOKING ? 'on' : 'currently paused: every "Book" button on the website shows "Online appointments are coming soon, please call". Desk bookings and Karen in the app work as normal'}.
- Prices: each booking takes the price the stylist typed. ${CLIENT_PRICES ? 'Clients see prices in their emails.' : 'Clients are not shown prices yet: their emails and their booking page leave prices out. The team sees them on the ticket.'}

EMAILS AND TEXTS
- Sent from noreply@synergysalon.com; replies go to the salon's reply-to address.
- Automatic: confirmation when a booking is made; reminder about ${REMINDER_LEAD_HOURS} hours ahead (a daily run picks up everything still booked for the next day or so, and each appointment is reminded once); reschedule when the time moves; cancellation; a welcome before a first visit; and follow-ups (no-show recovery, late cancellation, post-visit check-in, aftercare, review request, rebook reminder, second visit, win-back). Each can be switched off in Settings, Automations.
- Every email has a link where the client can see, move or cancel their own appointment.
- Texts go only to clients who agreed to texts on the website's opt-in form (or replied START). Replying STOP opts them out. The salon's texting number is Karen's.

GOOGLE CALENDAR
- Connected from the team member window (Connect your tools). Bookings, lunches and blocks are copied into a calendar named after the salon in their Google account; their own busy times stop online bookings.
- The Google connection is still in Google's testing mode: only people on its test list can connect, and a connection stops working after about seven days and has to be connected again. Google shows a "hasn't verified this app" screen; press Continue.

COMMON PROBLEMS
- A stylist isn't offered on the website: they need a service switched on, working hours, and a connected Google Calendar (and online booking is ${ONLINE_BOOKING ? 'on' : 'paused anyway'}).
- No times show for a day: it's outside their hours or a day off, it's fully booked, the lunch window needs its half hour, or the time has passed.
- A stylist can't change their own hours: only the admin can.
- An email shows Failed: the provider refused it, usually a wrong address; the reason is on the email in Email History or the client's Activity. Fix the address on the profile.
- A client didn't get a text: they haven't opted in to texts, or texting isn't connected yet.
- A stylist's Google column says disconnected: they reconnect from their team member window.
- Someone can't edit a colleague: only the admin can.`;
