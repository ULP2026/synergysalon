/**
 * Create the booking schema and load the starting data.
 *
 *   DATABASE_URL=postgres://… node db/setup.js          # schema + seed
 *   DATABASE_URL=postgres://… node db/setup.js --reset  # drop everything first
 *
 * --reset destroys every appointment in the database. It exists for local
 * work and for the first deploy, and it asks before doing anything when it
 * can see it is pointed at something that is not localhost.
 */
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const reset = process.argv.includes('--reset');
const url = process.env.DATABASE_URL;

if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const isLocal = url.includes('localhost') || url.includes('127.0.0.1');

if (reset && !isLocal) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const host = url.replace(/\/\/[^@]*@/, '//');
  const answer = await rl.question(
    `\n--reset will DROP every booking table on:\n  ${host}\n\nType "drop" to continue: `,
  );
  rl.close();
  if (answer.trim() !== 'drop') {
    console.log('Nothing was changed.');
    process.exit(0);
  }
}

const client = new pg.Client({
  connectionString: url,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});
await client.connect();

try {
  if (reset) {
    await client.query(`
      DROP TABLE IF EXISTS appointments, stylist_services, stylist_hours, time_off,
                           services, stylists CASCADE;
      DROP TYPE IF EXISTS appointment_status;
    `);
    console.log('dropped existing tables');
  }

  await client.query(await readFile(join(here, 'schema.sql'), 'utf8'));
  console.log('schema created');

  const { rows } = await client.query('SELECT count(*)::int AS n FROM services');
  if (rows[0].n === 0) {
    await client.query(await readFile(join(here, 'seed.sql'), 'utf8'));
    console.log('seed data loaded');
  } else {
    console.log(`seed skipped: ${rows[0].n} services already present`);
  }

  const counts = await client.query(`
    SELECT (SELECT count(*) FROM services)     AS services,
           (SELECT count(*) FROM stylists)     AS stylists,
           (SELECT count(*) FROM stylist_hours) AS shifts,
           (SELECT count(*) FROM appointments)  AS appointments`);
  console.table(counts.rows[0]);
} finally {
  await client.end();
}
