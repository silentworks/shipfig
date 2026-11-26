/**
 * Runs once when a Next.js server starts. Postgres migrations are applied
 * first and block startup, so no request sees a database without its tables.
 * Recovery (SIL-536) resumes or
 * safely stops the job a restart interrupted and deletes orphaned job
 * sprites. It runs in the background so it never delays startup, and only in
 * the Node.js runtime.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { migrateOnStartup } = await import("./lib/db/migrate");
  await migrateOnStartup();
  void (async () => {
    try {
      const { recoverOnStartup } = await import("./lib/jobs/startup");
      await recoverOnStartup();
    } catch (error) {
      console.error("[shipfig] startup recovery failed:", error instanceof Error ? error.message : error);
    }
  })();
}
