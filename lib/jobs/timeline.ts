import type { JobState } from "./states";
import type { Job, JobEvent } from "./store";

/**
 * The job's progress as ordered steps, derived only from recorded state
 * transitions (real timestamps, no simulated progress). Only the current
 * attempt is shown; a retry starts the timeline again.
 */

export type StepStatus = "done" | "current" | "waiting" | "failed" | "canceled" | "upcoming";

export interface TimelineStep {
  key: string;
  label: string;
  status: StepStatus;
  startedAt: string | null;
  endedAt: string | null;
  /** Extra detail, e.g. repair attempts. */
  note: string | null;
}

const STEPS: readonly { key: string; label: string; state: JobState; waitsForHuman?: boolean }[] = [
  { key: "queued", label: "Queued", state: "queued" },
  { key: "workspace", label: "Workspace ready", state: "provisioning" },
  { key: "plan", label: "Plan drafted", state: "planning" },
  { key: "plan_approval", label: "Plan approved", state: "awaiting_plan_approval", waitsForHuman: true },
  { key: "edit", label: "Patch applied", state: "editing" },
  { key: "checks", label: "Checks completed", state: "testing" },
  { key: "publish_approval", label: "Publish approved", state: "awaiting_publish_approval", waitsForHuman: true },
  { key: "publish", label: "Draft PR opened", state: "publishing" },
];

const indexOf = (state: JobState | null) => STEPS.findIndex((s) => s.state === state);

export function jobTimeline(job: Pick<Job, "state">, events: readonly JobEvent[]): TimelineStep[] {
  const transitions = events.filter((e) => e.kind === "transition");
  // Current attempt: everything after the last restart out of `failed`.
  let start = 0;
  transitions.forEach((e, i) => {
    if (e.fromState === "failed") start = i;
  });
  const attempt = transitions.slice(start);

  // When each state was first entered and last left in this attempt.
  const entered = new Map<JobState, string>();
  const left = new Map<JobState, string>();
  let repairs = 0;
  for (const e of attempt) {
    if (e.toState && !entered.has(e.toState)) entered.set(e.toState, e.at);
    if (e.fromState) left.set(e.fromState, e.at);
    if (e.fromState === "testing" && e.toState === "editing") repairs++;
  }
  // A job created before its first event still starts at "queued".
  const first = attempt[0];
  if (first && !first.fromState && first.toState) entered.set(first.toState, first.at);

  // Where the job is (or where it stopped).
  const terminal = job.state === "failed" || job.state === "canceled" ? attempt.findLast((e) => e.toState === job.state) : undefined;
  const stoppedAt = terminal ? indexOf(terminal.fromState) : -1;
  const currentIndex = job.state === "completed" ? STEPS.length : terminal ? stoppedAt : indexOf(job.state);

  return STEPS.map((step, i) => {
    let status: StepStatus;
    if (i < currentIndex) status = "done";
    else if (i > currentIndex) status = "upcoming";
    else if (terminal) status = job.state === "failed" ? "failed" : "canceled";
    else status = step.waitsForHuman ? "waiting" : "current";

    const startedAt = entered.get(step.state) ?? null;
    const endedAt = status === "done" || status === "failed" || status === "canceled" ? (left.get(step.state) ?? terminal?.at ?? null) : null;
    let note: string | null = null;
    if (step.key === "edit" && repairs > 0) note = `${repairs} repair attempt${repairs === 1 ? "" : "s"}`;
    return { key: step.key, label: step.label, status, startedAt: status === "upcoming" ? null : startedAt, endedAt, note };
  });
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
