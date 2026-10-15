/**
 * The Home dashboard's widgets and the layout the admin arranges them in.
 *
 * The catalog lives here, on the server, because the server is what counts
 * the numbers: a widget the browser knew about and the server did not would
 * be a card with nothing in it. The browser draws whatever this says.
 *
 * A layout is a list of { id, view, size }:
 *   id    one of WIDGETS
 *   view  how it is drawn, one of that widget's views
 *   size  'half' or 'full', the width on a wide screen
 * Stored on the tenant (tenants.home_layout, 019) because the whole team
 * looks at the same Home. Null means DEFAULT_LAYOUT.
 */
import { HttpError } from './http.js';

export const WIDGETS = {
  today: {
    title: 'Salon Appointments', views: ['number'],
    about: 'Booked today, and how many in the last 30 days.',
  },
  clients30: {
    title: 'Clients Served', views: ['number'],
    about: 'Clients seen in the last 30 days, and how many were new.',
  },
  upcoming: {
    title: 'Coming up', views: ['list'],
    about: 'The next six booked appointments.',
  },
  ahead: {
    title: 'Booked ahead', views: ['bar', 'table'],
    about: 'Appointments on each of the next 14 days.',
  },
  visits: {
    title: 'Visits per week', views: ['bar', 'line', 'table'],
    about: 'Appointments kept in each of the last 12 weeks.',
  },
  value: {
    title: 'Booked value per week', views: ['bar', 'line', 'table'],
    about: 'What the last 12 weeks of appointments were priced at.',
  },
  services: {
    title: 'Services, last 30 days', views: ['bars', 'table'],
    about: 'Appointments by kind of service.',
  },
  stylists: {
    title: 'Stylists, last 30 days', views: ['bars', 'table'],
    about: 'Appointments by stylist.',
  },
  sources: {
    title: 'New clients by source', views: ['bars', 'table'],
    about: 'Where the last 30 days of new clients came from.',
  },
  weekdays: {
    title: 'Busiest days', views: ['bar', 'table'],
    about: 'Appointments by day of the week, last 90 days.',
  },
};

// What a salon sees before anybody customises: the two numbers and Coming
// up as they always were, with two graphics between them.
export const DEFAULT_LAYOUT = [
  { id: 'today', view: 'number', size: 'half' },
  { id: 'clients30', view: 'number', size: 'half' },
  { id: 'ahead', view: 'bar', size: 'half' },
  { id: 'services', view: 'bars', size: 'half' },
  { id: 'upcoming', view: 'list', size: 'full' },
];

/**
 * A layout as sent by the editor, cleaned: known widgets only, each once, a
 * view it supports and a known size. Anything else is dropped rather than
 * stored, so the column only ever holds what the page can draw.
 */
export function layoutFrom(value) {
  if (!Array.isArray(value)) throw new HttpError(400, 'That layout could not be read.');
  const out = [];
  for (const item of value.slice(0, 30)) {
    const w = WIDGETS[item?.id];
    if (!w || out.some((x) => x.id === item.id)) continue;
    out.push({
      id: item.id,
      view: w.views.includes(item.view) ? item.view : w.views[0],
      size: item.size === 'full' ? 'full' : 'half',
    });
  }
  return out;
}

/** What is stored, or the default; a stored layout that no longer reads falls back. */
export function layoutOf(stored) {
  if (stored == null) return DEFAULT_LAYOUT;
  try { return layoutFrom(typeof stored === 'string' ? JSON.parse(stored) : stored); } catch { return DEFAULT_LAYOUT; }
}
