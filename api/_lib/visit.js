/**
 * The services of one visit, the same everywhere (asked for 2026-10-31: a
 * booking of several services showed only its first on the ticket, in the
 * emails and in the client's activity).
 *
 * An appointment row has one service_id, the first of the visit. Every
 * service of it is itemized in appointments.services (migration 031,
 * written at booking from combineServices().lines). Before that column
 * exists, or for a visit booked before it, the website's own list in the
 * notes ("Services: ...", enquiry.js) is the next best record, and the
 * first service alone the last. Nothing is ever guessed.
 */

/**
 * SQL for the visit's name, its services joined with " + " in the order
 * they were booked. Through to_jsonb, so it runs on a database without the
 * column. `a` is the appointments alias, `v` the services alias.
 */
export function visitNameSql(a = 'a', v = 'v') {
  return `COALESCE(
    (SELECT string_agg(x.l ->> 'name', ' + ' ORDER BY x.o)
       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(to_jsonb(${a}) -> 'services') = 'array'
                                      THEN to_jsonb(${a}) -> 'services' END) WITH ORDINALITY AS x(l, o)
      WHERE x.l ->> 'name' <> ''),
    replace(substring(${a}.notes from '(?n)^Services: (.+)$'), ', ', ' + '),
    ${v}.name)`;
}

/** SQL for the itemized lines, or NULL. */
export function visitLinesSql(a = 'a') {
  return `CASE WHEN jsonb_typeof(to_jsonb(${a}) -> 'services') = 'array' THEN to_jsonb(${a}) -> 'services' END`;
}

/**
 * The lines as the app shows them: name, price in cents (null when the
 * service has none) and minutes. From the itemized list when there is
 * one; otherwise one line per name in the visit's name, unpriced, since
 * how a total split between them was never recorded.
 */
export function visitLines(lines, name) {
  if (Array.isArray(lines) && lines.length) {
    return lines.map((l) => ({
      name: String(l?.name || ''),
      priceCents: Number.isFinite(l?.priceCents) ? l.priceCents : null,
      durationMin: Number.isFinite(l?.durationMin) ? l.durationMin : null,
    })).filter((l) => l.name);
  }
  return String(name || '').split(' + ').filter(Boolean)
    .map((n) => ({ name: n, priceCents: null, durationMin: null }));
}
