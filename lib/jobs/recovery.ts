import { redact } from "@/lib/redact";
import type { JobState } from "./states";
import type { Job, JobStore } from "./store";

/**
 * Safe resume after a server restart (SIL-536). The runner is in-process, so
 * a restart strands the active job. On startup:
 *
 * - queued / provisioning / planning are safe to re-run (provisioning
 *   replaces the sprite; planning is read-only), so they resume;
 * - publishing resumes from the bundle frozen at verification (idempotent);
 * - editing / testing may have left the workspace half-changed, so the job
 *   fails as `interrupted` with its evidence kept, and the operator retries;
 * - jobs waiting for a human stay as they are (their deadlines still apply).
 *
 * Sprites of this instance's finished jobs are deleted, so crashes do not
 * leak sprites. Sprites for job ids this database does not know are left
 * alone: they may belong to another Shipfig instance on the same account.
 */

const RESUMABLE: ReadonlySet<JobState> = new Set(["queued", "provisioning", "planning", "publishing"]);
const INTERRUPTIBLE: ReadonlySet<JobState> = new Set(["editing", "testing"]);
export const JOB_SPRITE_PREFIX = "shipfig-job-";

export interface RecoveryDeps {
  store: JobStore;
  kick(jobId: string): void;
  listJobSprites(): Promise<string[]>;
  destroySprite(name: string): Promise<boolean>;
  log(message: string): void;
}

export interface RecoveryReport {
  resumed: string[];
  interrupted: string[];
  deletedSprites: string[];
}

export async function recoverJobs(deps: RecoveryDeps): Promise<RecoveryReport> {
  const report: RecoveryReport = { resumed: [], interrupted: [], deletedSprites: [] };
  const { store } = deps;

  // Expire first so a long-dead job is not resumed past its deadline.
  store.expireTimedOut();
  const active: Job | undefined = store.activeJob();
  if (active) {
    if (INTERRUPTIBLE.has(active.state)) {
      try {
        store.transition(active.id, "failed", {
          expectedVersion: active.version,
          message: `Shipfig restarted while ${active.state}; stopped to avoid continuing from a half-changed workspace`,
          patch: { failureReason: "interrupted", error: `The server restarted while the job was ${active.state}. The diff and results so far are kept; retry to start again.` },
        });
        report.interrupted.push(active.id);
      } catch (error) {
        deps.log(`could not mark ${active.id} interrupted: ${redact((error as Error).message)}`);
      }
    } else if (RESUMABLE.has(active.state)) {
      store.log(active.id, "info", `Resuming after a server restart (${active.state})`);
      report.resumed.push(active.id);
    }
  } else {
    // No active job at startup: promote the next waiting queued job, if any.
    const promoted = store.promoteNext();
    if (promoted) report.resumed.push(promoted.id);
  }
  // Terminal jobs still need their sprite cleanup, and resumed jobs need driving.
  for (const id of report.resumed.concat(report.interrupted)) deps.kick(id);

  // Delete sprites of this instance's jobs that are no longer active.
  let names: string[] = [];
  try {
    names = await deps.listJobSprites();
  } catch (error) {
    deps.log(`could not list sprites: ${redact((error as Error).message)}`);
  }
  for (const name of names) {
    if (!name.startsWith(JOB_SPRITE_PREFIX)) continue;
    const job = store.find(name.slice(JOB_SPRITE_PREFIX.length));
    if (!job || job.spriteName !== name || store.activeJob()?.id === job.id) continue;
    try {
      if (await deps.destroySprite(name)) report.deletedSprites.push(name);
    } catch (error) {
      deps.log(`could not delete ${name}: ${redact((error as Error).message)}`);
    }
  }
  return report;
}
