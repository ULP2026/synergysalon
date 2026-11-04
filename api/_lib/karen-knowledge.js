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

Who sees what: only the salon owner (role Owner or Admin) sees everyone's calendar, appointments and clients, the Team, Money and Automations. Everybody else, stylists included, sees only their own chair: their own appointments on Appt. Book and Home, the clients booked with them (or added by them), and their own account; they book only into their own chair. A team member with no chair sees no appointments.

Someone new: the owner invites a team member from Settings, Team, Add Team Member, with only their name, phone number, email and role, and presses Send Invitation. A window says they have been invited, and you (Karen) say "I'll take it from here!": you send them a welcome email (kept in Email History) and a welcome text from your number once texting is connected, introducing yourself and the app, with a one-time link (7 days) to choose their own password. This is the Team Member Invitation automation in Settings, Automations; switched off, nothing is sent and the owner is shown the link to pass on. You greet them on the password page, then walk them through setting up their account before anything else opens: a profile photo (uploaded and cropped; there are no avatars to choose in setup and no title to type), their name and mobile number (a stylist must give a mobile), then for a stylist their services with each service's own price and minutes, their hours (with the flexible lunch break), then connecting Google Calendar (or skipping it), and a review. The owner can resend an invitation from the person's window in Team while it is unused.

Home
- A greeting, then two figures: salon appointments today and in the last 30 days (opens Appt. Book), and clients served in the last 30 days with how many were new (opens Clients).
- Charts the admin arranged, and "Coming up": the next six booked appointments; clicking one opens it on Appt. Book.

Appt. Book
- Day view: one column per team member who has connected their Google Calendar, headed with their role. A stylist who has not connected gets a column only on days they have a booking or block. Bookings with no stylist share an "Unassigned" column.
- The day runs only through the salon's working hours that day, taken from the team's own hours in Settings, Team: from the earliest anyone starts to the latest anyone finishes (if the team works 9 AM to 6 PM on Monday, Monday shows 9 AM to 6 PM). A day nobody works shows "closed" unless something is booked on it. It is longer only if an appointment or block sits outside those hours.
- Each column shows their bookings, their Google busy times, lunches and blocks. Time outside their working hours is hatched "Block · Not bookable" ("Starts 9 AM", "Done at 4 PM", "Not working today"). Time that has passed is greyed out. Neither can be clicked to book.
- Their flexible lunch shows as a dashed "Lunch · flexible" band where it currently falls.
- Click an empty time in someone's column to book with them. Lunch and Block can be added to a column; a block really stops that time being booked, online and at the desk, and is copied to their Google Calendar if they signed in with Google.
- A colour with a processing break shows its Start, a dashed "Processing · free" band (the stylist is free, and that time can be booked), and its Finish.
- Month view shows the bookings per day. The day reloads by itself every two minutes and when the tab comes back into focus.
- Clicking an appointment opens its window (the ticket): client, stylist, when, each service with quantity, time and price, the total, who booked it, payment ("Not recorded": the app takes no payments yet). No Show, Cancel Appt. and Move Appt. are the small buttons above the details, with Check in as the main button at the right end of that row (Done once they are checked in, Reopen for a cancelled one if the time is still free); Delete Ticket is at the bottom left (owners, admins and managers only); the client's name opens their profile. To move an appointment, open it and press Move Appt. (pick the day, the stylist and one of the free times), or drag its card on Appt. Book's day to a new time or into another stylist's column, or in the Month view drag it onto another date, which opens Move on that date with the same time picked if it is free (on a phone, press and hold first). A confirmation window shows the client, the original and new date and time, and asks whether to Send the Client a Notification (email, and a text if they agreed to texts) or Just Move the Appointment (no message to the client); Cancel leaves it where it was. Once confirmed the card moves to its new place at once and the day or month updates where it is, without reloading the page. The app checks the time is free in that stylist's hours and keeps the visit's length and services. Any appointment that is still booked can be moved, one from earlier today included, to a time from now on; done, no-show and cancelled ones cannot. The client can also move their own appointment from the link in their emails.

New appointment (the "New appointment" button, or a click on Appt. Book)
- Five steps: stylist (or first available), kind of service (Color, Cuts, Treatments, Styling), the service, day and time, then the client.
- "Add another service" books several services as one visit with one stylist, end to end.
- The day and time step only offers times that really work: passed and taken times are struck through. The client step finds an existing client from the third letter typed, or takes a new one's name with a phone or email.
- "Help me book" in its header opens this chat with what has been chosen so far.

Clients
- The list, a search, and "Choose your stylist" (each client is grouped under whoever they last booked with). Each row's Book button books them with that stylist.
- A client's profile: in the header, their status (click it to change it: New, Contacted, Booked, Client, Lost), Card on file, and their tags (the plus or pencil beside them adds, renames and removes tags). Then their appointments (Appt. Book), contact details edited with the pencil; Payments (the "Card on file" switch: a flag only, the app stores no card); Contact preferences (Email and Text messages switches; turning email off stops follow-up emails, while confirmations, reminders and cancellations still go); notes (Add note puts a dated line on top); and Activity.
- Activity, with filters for Appointments, Email, SMS and Admin: "Client Created", every booking as "Appointment Booked" with the appointment's own date and a small picture on its icon's corner of who booked it (Karen, the team member, or the client on the website), check-ins, done, no-shows, cancellations, every email and text with who sent it (an automation's are titled with the automation's name, such as Appointment Booking, Appointment Reminder or Reschedule Notice), and Admin: every change the team made to the client's details (name, phone, email, status, tags, notes, preferences, card on file), what it was and what it became, who made it and when.
- At the foot of Activity they can be written to: Text (the default, in blue) or Email (in red).

Settings
- My Settings: your name and role, Edit my profile, My services, pricing & hours (your own services with price and minutes, and your available hours; Save my services & hours; the owner sees and can change everyone's in Team), Appearance (light, dark or match the device; per browser), Language, Sign out. For anyone but the salon owner, My Settings is the only Settings tab: Salon, Team, Automations, Money and Karen AI are the owner's, and so is the Choose your stylist filter on Clients.
- Salon: Salon Profile (the logo on the left with Change logo and Remove; beside it Salon name, Phone, Website, Google review link, Address, Booking page and Time zone; the pencil edits them in place, with Save and Cancel; Booking page and Time zone are set by the app; the logo is the menu's mark) and "Where do you want people to reply to" (the reply-to address on every client email).
- Team: for the owner, everyone on the team, each with Calendar and Payroll status (Connected or Disconnected), and Invited or Setting up for someone new; anyone else sees only their own account. Only the owner adds people, changes anybody else's details, hours or role, or removes someone. Removing someone with appointments still to come first asks who takes them (each keeps its time, and the client can be told or not); the owner can instead remove them and move the appointments later from that stylist's column on Appt. Book, marked "Removed from team", with Move appointments. Past visits stay under the name of whoever did them. Add Team Member asks for name, phone number, email and role, and Send Invitation has Karen email and text them a one-time link to choose their own password (Resend invitation in their window sends a fresh one). A stylist's mobile number is required (it is how Karen knows them by text).
- The team member window: picture (upload and crop, or choose an avatar), name and phone, email and role, Connect your tools (Google Calendar; Stripe for payroll is coming soon), Services & pricing (Cuts, Color, Treatments, Styling, each switched on with a duration, and opening to its services, each with its own price; Color and Highlights have Start, Break and Finish times; switching a kind on shows every service in it, to untick the ones that person does not do and type minutes for any service that takes them a different time, and switching it off folds them away, keeping what was typed; one box, "Special Instructions When Booking Clients"), and Available Hours with the Lunch break switch. Available Hours and the lunch switch are set by the admin only.
- Automations: the twelve automated client emails and the Team Member Invitation (Karen's welcome email and text to somebody invited to the team), each with an On/Off switch (turning one off asks you to type its name); opening one shows its steps and, under them, its Sent History (open it from its header): every client it emailed or texted, Email or SMS, when, and Sent or Failed. Email History is under the list (open it from its header): every email sent, team invitations included (their setup link is never kept), with search and a filter, Failed ones marked; clicking one shows the email as rebuilt from the booking now.
- Money (it was called Payments): Finance first (what visits were worth in a period, by stylist; the app records no payments yet, so this is the booked value, not money received), then Subscription, which shows the Synergy app plan, its price (not set yet, so it says "Pricing coming soon") and an Activate subscription button that is coming soon; then Payroll, coming soon (owners, admins and managers).
- Karen AI: Karen's phone number, which clients can call or text. For the admin, two histories that open and close from their headers: Chat History (every team member's conversations with Karen, in the app and by text; Karen's messages on the right in blue, the team member's on the left in gray) and Call History (every call to her number, who called, and whether the salon answered).

BOOKING RULES (true for the website, the desk, Karen and the client's own reschedule)
- A booking can only start inside the stylist's working hours (their Available Hours in Settings, Team) and must finish by the end of them. A day with no hours is a day off.
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
