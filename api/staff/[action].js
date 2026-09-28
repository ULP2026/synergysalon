/**
 * Every staff endpoint, behind one serverless function.
 *
 * Vercel's Hobby plan allows twelve functions per deployment and one file
 * under api/ becomes one function, so ten separate staff endpoints took the
 * whole project over the limit: the build succeeded and the deploy was
 * refused. A dynamic segment collapses them into a single function while
 * keeping the URLs exactly as they were.
 *
 * The handlers live under _routes/ because Vercel ignores paths beginning
 * with an underscore, which is what stops them becoming functions again.
 */
import { json } from '../_lib/http.js';

import appointment from './_routes/appointment.js';
import availability from './_routes/availability.js';
import book from './_routes/book.js';
import contacts from './_routes/contacts.js';
import diary from './_routes/diary.js';
import login from './_routes/login.js';
import logout from './_routes/logout.js';
import me from './_routes/me.js';
import requestAccess from './_routes/request-access.js';
import team from './_routes/team.js';

const ROUTES = {
  appointment,
  availability,
  book,
  contacts,
  diary,
  login,
  logout,
  me,
  'request-access': requestAccess,
  team,
};

export default async function handler(req, res) {
  // Vercel supplies the dynamic segment, but a direct invocation may not, so
  // fall back to the last path segment.
  const fromQuery = req.query?.action;
  const action = typeof fromQuery === 'string' && fromQuery
    ? fromQuery
    : new URL(req.url, 'http://localhost').pathname.split('/').filter(Boolean).pop();

  const route = Object.prototype.hasOwnProperty.call(ROUTES, action) ? ROUTES[action] : null;
  if (!route) return json(res, 404, { error: 'Not found' });

  return route(req, res);
}
