/**
 * Make a stylist bookable for the duration of a test.
 *
 * Not a test file: the runner's glob is `tests/*.test.js`, so this is only
 * ever imported.
 *
 * The integration tests were written against `db/seed.sql`, where Dina is an
 * active stylist offering the salon's services. Run against the live
 * database they all fail with "That stylist does not offer this service",
 * because the real Dina is switched off and has no `stylist_services` rows
 * until the salon fills them in. That is correct for production and wrong
 * for a test: a test that only passes on one particular database is testing
 * the database, not the code.
 *
 * So each test makes its own fixture. Every caller is already inside a
 * transaction it rolls back, so nothing here outlives the test, and the
 * production rows are untouched the moment it finishes.
 *
 * `loadStylists` (availability.js) needs two things, which is exactly what
 * this gives it: the stylist active, and a `stylist_services` row for the
 * service being booked.
 */

/**
 * Switch a stylist on and give them every active service this salon offers.
 *
 * Returns the stylist's id, for a caller that needs to go further.
 */
export async function makeBookable(client, tenantId, slug = 'dina') {
  // Refuse to run outside a transaction.
  //
  // This helper writes. On 20 October a caller ran it before its BEGIN, the
  // fixture committed, and four of the salon's stylists were left switched on
  // and bookable in production. A first attempt at this guard read
  // pg_stat_activity.state, which is "active" while the query runs either
  // way, so it never fired and wrote a second time.
  //
  // SAVEPOINT is the thing Postgres itself refuses outside a transaction
  // block (25P01), so it answers the question instead of guessing at it.
  try {
    await client.query('SAVEPOINT bookable_guard');
    await client.query('RELEASE SAVEPOINT bookable_guard');
  } catch {
    throw new Error(
      'makeBookable writes, so it must run inside a transaction the test rolls '
      + 'back. Call it after BEGIN, never before.',
    );
  }

  const { rows } = await client.query(
    'UPDATE stylists SET active = true WHERE tenant_id = $1 AND slug = $2 RETURNING id',
    [tenantId, slug],
  );
  if (!rows[0]) throw new Error(`No stylist "${slug}" in this salon to make bookable.`);
  const stylistId = rows[0].id;

  // Every active service, so a test can book whichever one it needs without
  // naming them here and drifting the first time the menu changes.
  await client.query(
    `INSERT INTO stylist_services (stylist_id, service_id)
     SELECT $1, v.id FROM services v WHERE v.tenant_id = $2 AND v.active
     ON CONFLICT DO NOTHING`,
    [stylistId, tenantId],
  );

  // Hours, if they have none: availability offers nothing without them.
  //
  // The salon's real published week, copied from db/seed.sql, not a flat
  // nine-to-five. Tests assert against the closing time -- "Tuesday closes at
  // 3, so the last start that finishes by then is 1:00" -- so inventing wider
  // hours here silently breaks them in a way that looks like a product bug.
  // Sunday is absent on purpose: the salon is shut.
  const { rows: hrs } = await client.query(
    'SELECT count(*)::int AS n FROM stylist_hours WHERE stylist_id = $1',
    [stylistId],
  );
  if (!hrs[0].n) {
    await client.query(
      `INSERT INTO stylist_hours (stylist_id, weekday, starts_at, ends_at)
       VALUES ($1, 1, '09:00', '15:00'), ($1, 2, '09:00', '15:00'),
              ($1, 3, '09:00', '19:00'), ($1, 4, '09:00', '19:00'),
              ($1, 5, '09:00', '18:00'), ($1, 6, '09:00', '15:00')`,
      [stylistId],
    );
  }

  return stylistId;
}

/**
 * The slug of a stylist who is already bookable, without changing anything.
 *
 * For the tests that commit rather than roll back. Switching somebody on in
 * those would outlive the run, and a stylist left switched on is exactly the
 * failure the salon paused online booking over: a guest offered a chair
 * nobody meant to sell. So those tests use whoever is already set up instead.
 */
export async function anyBookable(client, tenantId) {
  const { rows } = await client.query(
    `SELECT s.slug
       FROM stylists s
      WHERE s.tenant_id = $1 AND s.active
        AND EXISTS (SELECT 1 FROM stylist_services x WHERE x.stylist_id = s.id)
        AND EXISTS (SELECT 1 FROM stylist_hours h WHERE h.stylist_id = s.id)
      ORDER BY s.sort_order
      LIMIT 1`,
    [tenantId],
  );
  if (!rows[0]) {
    throw new Error('No stylist in this salon is bookable, so this test has nobody to book.');
  }
  return rows[0].slug;
}
