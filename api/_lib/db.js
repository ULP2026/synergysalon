/**
 * One Postgres pool per warm serverless instance.
 *
 * Serverless functions spin up and down constantly, so the pool is kept small
 * and cached on globalThis: without that, every cold start opens new
 * connections and a busy morning exhausts the database's connection limit.
 */
import pg from 'pg';

const { Pool } = pg;

/** Postgres error code for a violated exclusion constraint (the slot is taken). */
export const EXCLUSION_VIOLATION = '23P01';
/** Violated unique constraint (a ref or token collided). */
export const UNIQUE_VIOLATION = '23505';

function createPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  return new Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Neon and Vercel Postgres terminate TLS at the pooler with a certificate
    // this client has no local root for.
    ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
  });
}

export function pool() {
  if (!globalThis.__synergyPool) globalThis.__synergyPool = createPool();
  return globalThis.__synergyPool;
}

export function query(text, params) {
  return pool().query(text, params);
}

/**
 * Whether a column exists yet, for code that ships ahead of its migration.
 *
 * Reads go through to_jsonb and need no check; a write to a column that is
 * not there fails the whole statement, so it asks first. A yes is remembered
 * for the life of the instance (columns are not dropped); a no is asked again
 * after a minute, so the first request after the migration runs sees it.
 */
const columnSeen = new Map();
export async function hasColumn(table, column, client = null) {
  const key = `${table}.${column}`;
  const seen = columnSeen.get(key);
  if (seen === true || (seen && Date.now() - seen < 60_000)) return seen === true;
  const { rows } = await (client || pool()).query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1::text AND column_name = $2::text`,
    [table, column],
  );
  columnSeen.set(key, rows.length ? true : Date.now());
  return rows.length > 0;
}

/**
 * Run `fn` inside a transaction, rolling back on any throw.
 *
 * Booking needs this: the overlap check and the insert have to be one atomic
 * step, or two people racing for the last Saturday slot both succeed.
 */
export async function transaction(fn) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // the connection is already gone; the original error is the useful one
    }
    throw err;
  } finally {
    client.release();
  }
}
