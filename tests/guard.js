/**
 * Decides which database the tests are allowed to touch, before any of them
 * run.
 *
 * Loaded through `--import` in the test script, so it runs once in every test
 * process and nothing has to be repeated in the eleven files that open a
 * connection.
 *
 * WHY THIS EXISTS. The integration tests book appointments, write staff
 * logins and switch stylists on. They were run against the live database
 * because that is what DATABASE_URL points at, and on 20 October a fixture
 * committed instead of rolling back and left four of the salon's stylists
 * active and bookable in production. The individual tests were fixed; this
 * removes the class of mistake rather than that one instance.
 *
 * HOW TO RUN THEM NOW. Put a separate database in TEST_DATABASE_URL -- a
 * branch, a local Postgres, anything that is not the salon's. Set it up with
 * `DATABASE_URL=<that> npm run db:setup`, which applies the schema and the
 * seed the tests were written against, and then `DATABASE_URL=<that> npm run
 * db:migrate`: setup stops at the base schema, and the tests cover things
 * added since, processing breaks among them. Then `npm test` uses it.
 *
 * Without it the tests refuse to run rather than quietly skipping, because a
 * suite that silently covers nothing is worse than one that stops and says
 * why. ALLOW_PRODUCTION_TESTS=1 overrides, for the rare deliberate case; it
 * is spelled out in full so nobody sets it by accident.
 */
const test = process.env.TEST_DATABASE_URL;
const live = process.env.DATABASE_URL;

if (test) {
  // Everything downstream reads DATABASE_URL, so point it at the test one
  // rather than asking eleven files to know about both.
  process.env.DATABASE_URL = test;
} else if (live && process.env.ALLOW_PRODUCTION_TESTS !== '1') {
  const host = (() => {
    try { return new URL(live).host; } catch { return 'the configured database'; }
  })();
  throw new Error([
    '',
    `Refusing to run the tests against ${host}.`,
    '',
    'These tests book appointments, create logins and switch stylists on.',
    'DATABASE_URL is the salon\'s live database, and a test that commits',
    'instead of rolling back changes what guests see.',
    '',
    'Set TEST_DATABASE_URL to a separate database and run:',
    '',
    '  DATABASE_URL=<that database> npm run db:setup     # schema and seed, once',
    '  DATABASE_URL=<that database> npm run db:migrate   # and everything since',
    '  npm test',
    '',
    'To run against this database anyway, knowing what it is:',
    '',
    '  ALLOW_PRODUCTION_TESTS=1 npm test',
    '',
  ].join('\n'));
}
