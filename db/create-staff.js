/**
 * Create or update a staff login.
 *
 *   npm run staff:create
 *
 * Interactive on purpose. A password passed as a command-line argument ends up
 * in shell history and in the process list, and the first account created is
 * usually the owner's.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import pg from 'pg';

import { MIN_PASSWORD_LENGTH, hashPassword } from '../api/_lib/password.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });

/**
 * Ask for something that should not be left on screen behind someone.
 *
 * This goes through the same readline interface as every other question
 * rather than reading stdin directly. Two consumers of stdin at once abort
 * each other, which is exactly what the previous version did: the interface
 * and the raw read fought over the stream and the whole script died with
 * ABORT_ERR before anyone could type a password.
 */
function askSecret(query) {
  stdout.write(query);
  const restore = rl._writeToOutput;
  rl._writeToOutput = () => {};          // swallow the echo of what is typed
  return rl.question('').finally(() => {
    rl._writeToOutput = restore;
    stdout.write('\n');
  });
}

const client = new pg.Client({
  connectionString: url,
  ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
});
await client.connect();

try {
  const { rows: tenants } = await client.query(
    'SELECT id, slug, name FROM tenants ORDER BY created_at',
  );
  if (!tenants.length) {
    console.error('No tenants exist yet. Run "npm run db:setup" first.');
    process.exit(1);
  }

  // Non-interactive path. Terminals vary in how they hand over stdin, and an
  // owner locked out of the console at 8am does not want to debug a prompt.
  // Set all four and the questions are skipped entirely:
  //   $env:STAFF_NAME='Dina Lara'; $env:STAFF_EMAIL='dina@…'
  //   $env:STAFF_ROLE='owner';     $env:STAFF_PASSWORD='…'
  //   npm run staff:create
  const env = process.env;
  const scripted = Boolean(env.STAFF_EMAIL && env.STAFF_PASSWORD && env.STAFF_NAME);

  console.log('\nSalons:');
  tenants.forEach((t, i) => console.log(`  ${i + 1}. ${t.name} (${t.slug})`));
  const pick = tenants.length === 1 || scripted
    ? (env.STAFF_SALON || '1')
    : await rl.question(`Which salon? [1-${tenants.length}] `);
  const tenant = tenants[Number(pick || '1') - 1];
  if (!tenant) { console.error('No such salon.'); process.exit(1); }

  const ask = async (query, fromEnv) => (scripted ? fromEnv : (await rl.question(query)).trim());

  const name = await ask('Full name: ', env.STAFF_NAME);
  const email = (await ask('Email: ', env.STAFF_EMAIL)).toLowerCase();
  const role = (await ask('Role [owner/manager/front_desk] (front_desk): ', env.STAFF_ROLE))
    || 'front_desk';
  if (!['owner', 'manager', 'front_desk'].includes(role)) {
    console.error(`"${role}" is not a role.`);
    process.exit(1);
  }

  const password = scripted
    ? env.STAFF_PASSWORD
    : await askSecret(`Password (min ${MIN_PASSWORD_LENGTH} chars): `);
  if (!scripted) {
    const again = await askSecret('Again: ');
    if (password !== again) { console.error('Those did not match.'); process.exit(1); }
  }

  const hash = await hashPassword(password);

  // Re-running with the same email resets that person's password, which is
  // what you actually want when someone is locked out.
  const { rows } = await client.query(
    `INSERT INTO staff_users (tenant_id, email, password_hash, name, role)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, lower(email))
       DO UPDATE SET password_hash = EXCLUDED.password_hash,
                     name = EXCLUDED.name,
                     role = EXCLUDED.role,
                     active = true
     RETURNING id, email, role, (xmax = 0) AS created`,
    [tenant.id, email, hash, name, role],
  );

  const user = rows[0];
  console.log(`\n${user.created ? 'Created' : 'Updated'} ${user.email} as ${user.role} at ${tenant.name}.`);

  // Any existing sessions belong to the old password.
  if (!user.created) {
    const { rowCount } = await client.query(
      'DELETE FROM staff_sessions WHERE user_id = $1', [user.id],
    );
    if (rowCount) console.log(`Signed out ${rowCount} existing session(s).`);
  }
} finally {
  rl.close();
  await client.end();
}
