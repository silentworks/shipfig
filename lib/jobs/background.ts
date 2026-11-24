import { kickJob } from "./runner";

/**
 * Fire-and-forget: run a job's automated stages in this server process without
 * tying them to the request's lifetime. Failures are recorded on the job by the
 * runner; this only guards against unhandled rejections.
 */
export function startJobInBackground(jobId: string): void {
  kickJob(jobId).catch(() => {});
}
