import { createPool } from "@vercel/postgres";
import type { QueryResult, QueryResultRow } from "@neondatabase/serverless";

type SqlPrimitive = string | number | boolean | undefined | null;

/**
 * Pooled serverless Postgres (Neon + Vercel).
 * Vercel/Neon expose both POSTGRES_* and DATABASE_URL; @vercel/postgres only
 * reads POSTGRES_URL by default, so we resolve explicitly.
 *
 * Prefer POSTGRES_URL, then DATABASE_URL (Neon's "recommended" pooled URL).
 *
 * Pool is created lazily so `next build` can run without DB env vars locally.
 */
let pool: ReturnType<typeof createPool> | null = null;

function getPool() {
  if (pool) return pool;
  const connectionString =
    process.env.POSTGRES_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error(
      "Missing POSTGRES_URL or DATABASE_URL. Copy from Vercel → Storage → Neon or run `vercel env pull`."
    );
  }
  pool = createPool({ connectionString });
  return pool;
}

export function sql<O extends QueryResultRow>(
  strings: TemplateStringsArray,
  ...values: SqlPrimitive[]
): Promise<QueryResult<O>> {
  return getPool().sql<O>(strings, ...values);
}

/** Minimal client surface used inside {@link withTransaction}. */
export type TxClient = {
  sql: <O extends QueryResultRow>(
    strings: TemplateStringsArray,
    ...values: SqlPrimitive[]
  ) => Promise<QueryResult<O>>;
  query: (text: string) => Promise<unknown>;
};

/**
 * Runs `fn` inside a single pooled connection wrapped in BEGIN/COMMIT.
 * Rolls back and rethrows on error. Use for check-then-insert sequences that
 * must not interleave (for example with pg_advisory_xact_lock).
 */
export async function withTransaction<T>(
  fn: (client: TxClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection may already be gone */
    }
    throw e;
  } finally {
    client.release();
  }
}
