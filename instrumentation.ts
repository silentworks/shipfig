/**
 * Runs once when a Next.js server starts. Recovery (SIL-536) resumes or
 * safely stops the job a restart interrupted and deletes orphaned job
 * sprites. It runs in the background so it never delays startup, and only in
 * the Node.js runtime.
 */
export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  void (async () => {
    try {
      const { recoverOnStartup } = await import("./lib/jobs/startup");
      await recoverOnStartup();
    } catch (error) {
      console.error("[shipfig] startup recovery failed:", error instanceof Error ? error.message : error);
    }
  })();
}
