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

/** Reads without echoing, so a password is not left on screen behind someone. */
async function secret(prompt) {
  stdout.write(prompt);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode?.(true);
  let out = '';
  for await (const chunk of stdin) {
    const s = chunk.toString('utf8');
    if (s === '\r' || s === '\n') break;
    if (s === '\u0003') { stdout.write('\n'); process.exit(130); }
    if (s === '\u007f' || s === '\b') out = out.slice(0, -1);
    else out += s;
  }
  stdin.setRawMode?.(wasRaw ?? false);
  stdout.write('\n');
  return out;
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

  console.log('\nSalons:');
  tenants.forEach((t, i) => console.log(`  ${i + 1}. ${t.name} (${t.slug})`));
  const pick = tenants.length === 1
    ? '1'
    : await rl.question(`Which salon? [1-${tenants.length}] `);
  const tenant = tenants[Number(pick || '1') - 1];
  if (!tenant) { console.error('No such salon.'); process.exit(1); }

  const name = (await rl.question('Full name: ')).trim();
  const email = (await rl.question('Email: ')).trim().toLowerCase();
  const role = (await rl.question('Role [owner/manager/front_desk] (front_desk): ')).trim()
    || 'front_desk';
  if (!['owner', 'manager', 'front_desk'].includes(role)) {
    console.error(`"${role}" is not a role.`);
    process.exit(1);
  }

  const password = await secret(`Password (min ${MIN_PASSWORD_LENGTH} chars): `);
  const again = await secret('Again: ');
  if (password !== again) { console.error('Those did not match.'); process.exit(1); }

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
