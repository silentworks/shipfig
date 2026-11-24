/**
 * Job lifecycle for a single Shipfig run:
 *
 *   queued → planning → awaiting_plan_approval → provisioning → editing → testing
 *          → awaiting_publish_approval → publishing → completed
 *
 * with `failed` and `canceled` as explicit terminal states, a bounded repair
 * loop (testing → editing) and a bounded retry (failed → queued).
 */

export const JOB_STATES = [
  "queued",
  "planning",
  "awaiting_plan_approval",
  "provisioning",
  "editing",
  "testing",
  "awaiting_publish_approval",
  "publishing",
  "completed",
  "failed",
  "canceled",
] as const;

export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set(["completed", "failed", "canceled"]);
export const AWAITING_HUMAN_STATES: ReadonlySet<JobState> = new Set(["awaiting_plan_approval", "awaiting_publish_approval"]);

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isJobState(value: string): value is JobState {
  return (JOB_STATES as readonly string[]).includes(value);
}

/** Max automated repair attempts after failed checks (testing → editing). */
export const MAX_REPAIR_ATTEMPTS = 2;
/** Max total attempts of a job (first run + retries after failure). */
export const MAX_ATTEMPTS = 3;

/** Legal transitions. Anything not listed is rejected. */
export const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ["planning", "failed", "canceled"],
  planning: ["awaiting_plan_approval", "failed", "canceled"],
  awaiting_plan_approval: ["provisioning", "failed", "canceled"],
  provisioning: ["editing", "failed", "canceled"],
  editing: ["testing", "failed", "canceled"],
  testing: ["awaiting_publish_approval", "editing", "failed", "canceled"],
  awaiting_publish_approval: ["publishing", "failed", "canceled"],
  // No cancel once publishing has started: it must finish or fail, never half-publish silently.
  publishing: ["completed", "failed"],
  completed: [],
  failed: ["queued"],
  canceled: [],
};

/**
 * Per-state time budget. A job that stays in a state longer than this is moved
 * to `failed` with reason `timeout`. Human-approval states get a longer window.
 */
export const STATE_TIMEOUT_MS: Readonly<Record<JobState, number | null>> = {
  queued: 10 * 60_000,
  planning: 5 * 60_000,
  awaiting_plan_approval: 60 * 60_000,
  provisioning: 10 * 60_000,
  editing: 15 * 60_000,
  testing: 15 * 60_000,
  awaiting_publish_approval: 60 * 60_000,
  publishing: 5 * 60_000,
  completed: null,
  failed: null,
  canceled: null,
};

export type FailureReason = "timeout" | "error" | "checks_failed" | "repair_limit" | "agent_error" | "sprite_error" | "publish_error";
export type CancelReason = "user_canceled" | "plan_rejected" | "publish_rejected";

export interface TransitionContext {
  retryCount: number;
  attempt: number;
}

/** Returns an error message if the transition is illegal, otherwise null. */
export function checkTransition(from: JobState, to: JobState, ctx: TransitionContext): string | null {
  if (!TRANSITIONS[from].includes(to)) {
    return `Illegal transition ${from} → ${to}`;
  }
  if (from === "testing" && to === "editing" && ctx.retryCount >= MAX_REPAIR_ATTEMPTS) {
    return `Repair limit reached (${MAX_REPAIR_ATTEMPTS} attempts)`;
  }
  if (from === "failed" && to === "queued" && ctx.attempt >= MAX_ATTEMPTS) {
    return `Retry limit reached (${MAX_ATTEMPTS} attempts)`;
  }
  return null;
}

export const STATE_LABELS: Readonly<Record<JobState, string>> = {
  queued: "Queued",
  planning: "Planning",
  awaiting_plan_approval: "Awaiting plan approval",
  provisioning: "Provisioning sprite",
  editing: "Editing",
  testing: "Testing",
  awaiting_publish_approval: "Awaiting publish approval",
  publishing: "Publishing",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
};
