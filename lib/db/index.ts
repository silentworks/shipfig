import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type AppDatabase = NodePgDatabase<typeof schema>;

const globalForPg = globalThis as unknown as {
  __shipfigPgPool?: Pool;
  __shipfigDrizzle?: AppDatabase;
};

/**
 * Process-wide Postgres connection pool and Drizzle ORM handle.
 *
 * `pg.Pool` connects lazily on first query, so importing this module during
 * `next build` or unit tests without `DATABASE_URL` does not attempt a network
 * connection.
 */
export function pgPool(): Pool {
  globalForPg.__shipfigPgPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
  });
  return globalForPg.__shipfigPgPool;
}

export function db(): AppDatabase {
  globalForPg.__shipfigDrizzle ??= drizzle(pgPool(), { schema });
  return globalForPg.__shipfigDrizzle;
}

export { schema };
