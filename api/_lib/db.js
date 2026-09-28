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
