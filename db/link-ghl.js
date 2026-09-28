/**
 * Store a tenant's CENTRO credentials, and check they work.
 *
 *   npm run ghl:link
 *
 * Reads GHL_LOCATION_ID, GHL_TOKEN and GHL_CALENDAR_ID from the environment
 * rather than taking them as arguments, so the token stays out of shell
 * history and the process list. Rotating it later means changing one env var
 * and re-running this, never editing code.
 */
import pg from 'pg';

const { DATABASE_URL, GHL_LOCATION_ID, GHL_TOKEN, GHL_CALENDAR_ID } = process.env;
const slug = process.argv[2] || 'synergy';

for (const [name, value] of Object.entries({
  DATABASE_URL, GHL_LOCATION_ID, GHL_TOKEN, GHL_CALENDAR_ID,
})) {
  if (!value) {
    console.error(`${name} is not set. Put it in .env (which is gitignored).`);
    process.exit(1);
  }
}

const api = async (path) => {
  const res = await fetch(`https://services.leadconnectorhq.com${path}`, {
    headers: {
      Authorization: `Bearer ${GHL_TOKEN}`,
      Version: '2021-07-28',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
};

// Prove the credentials work before storing them: a token saved now and found
// to be wrong at the first booking is the worst time to discover it.
console.log('Checking the credentials against CENTRO…');
const { location } = await api(`/locations/${GHL_LOCATION_ID}`);
const { calendar } = await api(`/calendars/${GHL_CALENDAR_ID}`);
console.log(`  sub-account : ${location.name}`);
console.log(`  calendar    : ${calendar.name} (${calendar.calendarType})`);
console.log(`  timezone    : ${location.timezone}`);

// CENTRO will not accept an appointment without a team member, so the
// calendar's own is stored as the default for every stylist we have not
// mapped individually.
const defaultUser = calendar.teamMembers?.[0]?.userId ?? null;
console.log(`  team member : ${defaultUser ?? 'NONE -- appointments will be refused'}`);

const client = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});
await client.connect();

try {
  const { rows } = await client.query(
    `UPDATE tenants
        SET ghl_location_id = $2, ghl_token = $3, ghl_calendar_id = $4,
            ghl_user_id = $5
      WHERE slug = $1
      RETURNING name, timezone`,
    [slug, GHL_LOCATION_ID, GHL_TOKEN, GHL_CALENDAR_ID, defaultUser],
  );
  if (!rows.length) {
    console.error(`No tenant with slug "${slug}". Run "npm run db:setup" first.`);
    process.exit(1);
  }

  console.log(`\nLinked ${rows[0].name} to ${location.name}.`);

  // A salon whose diary is generated on a different clock from the one CENTRO
  // shows it will produce appointments an hour out, twice a year, and nobody
  // will believe the cause.
  if (rows[0].timezone !== location.timezone) {
    console.warn(`\n  WARNING: timezone mismatch.`);
    console.warn(`  This system: ${rows[0].timezone}`);
    console.warn(`  CENTRO     : ${location.timezone}`);
    console.warn(`  Make them match before taking a booking.`);
  }
} finally {
  await client.end();
}
