/**
 * Apply the SQL files in db/migrations that have not run yet.
 *
 *   npm run db:migrate
 *
 * Each file runs once, recorded by filename. Statements are run one at a time
 * rather than as a single transaction, because ALTER TYPE ... ADD VALUE cannot
 * share a transaction with anything that then uses the new value.
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
});
await client.connect();

/** Splits on semicolons that end a statement, ignoring those inside quotes. */
function statements(sql) {
  const out = [];
  let buf = '';
  let quote = null;
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
      continue;
    } else if (c === ';') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const { rows } = await client.query('SELECT filename FROM migrations');
  const done = new Set(rows.map((r) => r.filename));

  const files = (await readdir(join(here, 'migrations')))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (done.has(file)) {
      console.log(`  skip  ${file}`);
      continue;
    }
    const sql = await readFile(join(here, 'migrations', file), 'utf8');
    process.stdout.write(`  run   ${file} … `);
    for (const stmt of statements(sql)) {
      try {
        await client.query(stmt);
      } catch (err) {
        // Re-running a partly applied migration should not stop on the parts
        // that are already there.
        const benign = ['42710', '42701', '42P07', '42704', '42P16'].includes(err.code);
        if (!benign) {
          console.log('FAILED');
          console.error(`\n${stmt.slice(0, 200)}\n\n${err.code}: ${err.message}`);
          process.exit(1);
        }
      }
    }
    await client.query('INSERT INTO migrations (filename) VALUES ($1)', [file]);
    console.log('done');
    ran += 1;
  }
  console.log(ran ? `\n${ran} migration(s) applied.` : '\nNothing to do.');
} finally {
  await client.end();
}
