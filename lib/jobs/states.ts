/**
 * Job lifecycle for a single Shipfig run:
 *
 *   queued → provisioning → planning → awaiting_plan_approval → editing → testing
 *          → awaiting_publish_approval → publishing → completed
 *
 * The workspace is provisioned (read-only use) before planning so the planner
 * can inspect real source; no edits happen until the plan is approved.
 *
 * with `failed` and `canceled` as explicit terminal states, a bounded repair
 * loop (testing → editing) and a bounded retry (failed → queued). A failed
 * publish can resume publishing (failed → publishing) from its saved bundle,
 * without redoing the approved work.
 */

export const JOB_STATES = [
  "queued",
  "provisioning",
  "planning",
  "awaiting_plan_approval",
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
  queued: ["provisioning", "failed", "canceled"],
  provisioning: ["planning", "failed", "canceled"],
  planning: ["awaiting_plan_approval", "failed", "canceled"],
  awaiting_plan_approval: ["editing", "failed", "canceled"],
  editing: ["testing", "failed", "canceled"],
  testing: ["awaiting_publish_approval", "editing", "failed", "canceled"],
  awaiting_publish_approval: ["publishing", "failed", "canceled"],
  // No cancel once publishing has started: it must finish or fail, never half-publish silently.
  publishing: ["completed", "failed"],
  completed: [],
  failed: ["queued", "publishing"],
  canceled: [],
};

/**
 * Per-state time budget. A job that stays in a state longer than this is moved
 * to `failed` with reason `timeout`. Human-approval states get a longer window.
 */
export const STATE_TIMEOUT_MS: Readonly<Record<JobState, number | null>> = {
  queued: 10 * 60_000,
  provisioning: 10 * 60_000,
  planning: 10 * 60_000,
  awaiting_plan_approval: 60 * 60_000,
  editing: 15 * 60_000,
  testing: 15 * 60_000,
  awaiting_publish_approval: 60 * 60_000,
  publishing: 5 * 60_000,
  completed: null,
  failed: null,
  canceled: null,
};

export type FailureReason =
  | "timeout"
  | "error"
  | "setup_error"
  | "needs_clarification"
  | "policy_violation"
  | "no_changes"
  | "review_failed"
  | "checks_failed"
  | "repair_limit"
  | "agent_error"
  | "sprite_error"
  | "publish_error";
export type CancelReason = "user_canceled" | "plan_rejected" | "publish_rejected";

export interface TransitionContext {
  retryCount: number;
  attempt: number;
  /** A failed publish whose approved file bundle was saved, so publishing can resume. */
  canResumePublish?: boolean;
}

/** Returns an error message if the transition is illegal, otherwise null. */
export function checkTransition(from: JobState, to: JobState, ctx: TransitionContext): string | null {
  if (!TRANSITIONS[from].includes(to)) {
    return `Illegal transition ${from} → ${to}`;
  }
  if (from === "testing" && to === "editing" && ctx.retryCount >= MAX_REPAIR_ATTEMPTS) {
    return `Repair limit reached (${MAX_REPAIR_ATTEMPTS} attempts)`;
  }
  if (from === "failed" && to === "publishing" && !ctx.canResumePublish) {
    return "Only a failed publish with a saved, approved bundle can resume publishing";
  }
  if (from === "failed" && to === "queued" && ctx.attempt >= MAX_ATTEMPTS) {
    return `Retry limit reached (${MAX_ATTEMPTS} attempts)`;
  }
  return null;
}

export const STATE_LABELS: Readonly<Record<JobState, string>> = {
  queued: "Queued",
  provisioning: "Provisioning workspace",
  planning: "Planning",
  awaiting_plan_approval: "Awaiting plan approval",
  editing: "Editing",
  testing: "Testing",
  awaiting_publish_approval: "Awaiting publish approval",
  publishing: "Publishing",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
};
