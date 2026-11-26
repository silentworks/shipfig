import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "./index";

/**
 * Apply pending Drizzle migrations (./drizzle) on server start, so a deployed
 * instance never runs against a database missing the auth tables. Uses the
 * same journal table as `npm run db:migrate`, so the two are interchangeable.
 */
export async function migrateOnStartup(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  await migrate(db(), { migrationsFolder: path.join(process.cwd(), "drizzle") });
  console.info("[shipfig] database migrations are up to date");
}
