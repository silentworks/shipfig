import { spritesClient } from "@/lib/sprites/client";
import { destroyJobSandbox } from "@/lib/sprites/sandbox";
import { startJobInBackground } from "./background";
import { JOB_SPRITE_PREFIX, recoverJobs } from "./recovery";
import { jobStore } from "./store";

/** Wire recovery to the real store, runner and Sprites API (called from instrumentation.ts). */
export async function recoverOnStartup(): Promise<void> {
  const haveSprites = Boolean(process.env.SPRITES_TOKEN);
  const report = await recoverJobs({
    store: jobStore(),
    kick: startJobInBackground,
    listJobSprites: async () => (haveSprites ? (await spritesClient().listAllSprites(JOB_SPRITE_PREFIX)).map((s) => s.name) : []),
    destroySprite: destroyJobSandbox,
    log: (message) => console.warn(`[shipfig] recovery: ${message}`),
  });
  const parts = [
    report.resumed.length ? `resumed ${report.resumed.join(", ")}` : "",
    report.interrupted.length ? `stopped interrupted ${report.interrupted.join(", ")}` : "",
    report.deletedSprites.length ? `deleted orphaned sprites ${report.deletedSprites.join(", ")}` : "",
  ].filter(Boolean);
  if (parts.length > 0) console.info(`[shipfig] recovery: ${parts.join("; ")}`);
}
