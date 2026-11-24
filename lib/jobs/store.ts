import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sanitizeOutput } from "@/lib/redact";
import type { PublishBundle, PublishResult } from "@/lib/publish/types";
import type { Verification } from "@/lib/verify/evidence";
import { type IssueRef, issueRefSchema } from "@/lib/validation";
import { database } from "./db";
import {
  type CancelReason,
  type FailureReason,
  type JobState,
  STATE_TIMEOUT_MS,
  checkTransition,
  isJobState,
  isTerminal,
} from "./states";

export type TestStatus = "passed" | "failed" | "timed_out" | "not_run";

/** Evidence for one verification command. `passed` only if it actually ran and exited 0. */
export interface TestResult {
  name: string;
  command: string[];
  status: TestStatus;
  exitCode: number | null;
  durationMs: number | null;
  output: string;
  /** One-line summary of what the tool reported (e.g. "3 passed (3)"). */
  summary?: string;
}

/** What provisioning found in the checkout; used by planning and verification. */
export interface WorkspaceInfo {
  /** Absolute path of the checkout inside the job sprite. */
  root: string;
  /** "npm" or "none" (no package.json). Other package managers are refused. */
  packageManager: "npm" | "none";
  /** package.json scripts (names and commands, truncated). */
  scripts: Record<string, string>;
  /** Exit code of the dependency install, or null if none was needed. */
  installExitCode: number | null;
}

/** One executor run (first attempt or a repair). */
export interface ExecutionAttempt {
  attempt: number;
  startedAt: string;
  finishedAt: string;
  /** The executor's own report: a claim, not evidence. */
  report: unknown;
  filesWritten: string[];
  refusals: string[];
  /** Checks the executor ran while editing (informational; the testing stage is authoritative). */
  agentCheckRuns: { name: string; status: string; exitCode: number | null }[];
  usage: { inputTokens: number; outputTokens: number; turns: number; toolCalls: number };
}

export interface Job {
  id: string;
  repoOwner: string;
  repoName: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  state: JobState;
  failureReason: FailureReason | null;
  cancelReason: CancelReason | null;
  error: string | null;
  spriteName: string | null;
  spriteId: string | null;
  baseBranch: string | null;
  /** Commit the workspace was checked out at (pinned before any edit). */
  baseSha: string | null;
  /** Sprite checkpoint taken after setup, before any edit. */
  checkpointId: string | null;
  workspace: WorkspaceInfo | null;
  branchName: string | null;
  /** PlanRecord from the planner (lib/agent/planner.ts). */
  plan: unknown;
  planApprovedAt: string | null;
  planApprovedBy: string | null;
  testResults: TestResult[];
  /** Checks run on the untouched checkout before any edit. */
  baselineResults: TestResult[];
  verification: Verification | null;
  /** sha256 of the raw diff the human reviews; publishing must match it (SIL-534). */
  diffHash: string | null;
  execution: ExecutionAttempt[];
  diff: string | null;
  prUrl: string | null;
  /** Publish approval: who approved, when, and the exact diff hash they approved. */
  publishApprovedAt: string | null;
  publishApprovedBy: string | null;
  publishApprovedHash: string | null;
  /** Whether the approved file bundle has been saved (its content is not exposed on the job). */
  hasPublishBundle: boolean;
  publishResult: PublishResult | null;
  retryCount: number;
  attempt: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  stateEnteredAt: string;
  deadlineAt: string | null;
  finishedAt: string | null;
}

export type JobEventKind = "transition" | "info" | "command" | "error";

export interface JobEvent {
  id: number;
  jobId: string;
  at: string;
  kind: JobEventKind;
  fromState: JobState | null;
  toState: JobState | null;
  message: string;
  data: unknown;
}

export class JobNotFoundError extends Error {
  constructor(id: string) {
    super(`Job ${id} not found`);
    this.name = "JobNotFoundError";
  }
}

export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}

export class ActiveJobExistsError extends Error {
  constructor(public readonly activeJobId: string) {
    super(`Another job (${activeJobId}) is already active; only one job may run at a time`);
    this.name = "ActiveJobExistsError";
  }
}

/** Fields a transition may set alongside the state change. */
export interface JobPatch {
  spriteName?: string;
  spriteId?: string | null;
  baseBranch?: string;
  baseSha?: string;
  checkpointId?: string;
  workspace?: WorkspaceInfo;
  branchName?: string;
  plan?: unknown;
  planApprovedAt?: string;
  planApprovedBy?: string;
  testResults?: TestResult[];
  execution?: ExecutionAttempt[];
  baselineResults?: TestResult[];
  verification?: Verification;
  diffHash?: string;
  diff?: string;
  prUrl?: string;
  publishApprovedAt?: string;
  publishApprovedBy?: string;
  publishApprovedHash?: string;
  publishResult?: PublishResult;
  /** The exact change to publish, frozen at verification time. Stored verbatim. */
  publishBundle?: PublishBundle;
  error?: string;
  failureReason?: FailureReason;
  cancelReason?: CancelReason;
}

export interface TransitionOptions {
  /** Reject if the job is not currently in this state (guards against stale callers). */
  expectedState?: JobState;
  /** Reject if the job's version changed (optimistic concurrency). */
  expectedVersion?: number;
  message?: string;
  patch?: JobPatch;
  now?: Date;
}

export interface NewJobInput extends IssueRef {
  issueTitle: string;
  issueUrl: string;
}

type Row = Record<string, string | number | null>;

const MAX_DIFF_CHARS = 200_000;
const MAX_PLAN_CHARS = 60_000;
const MAX_EVENT_CHARS = 8_000;
const MAX_ERROR_CHARS = 4_000;

function parseJson<T>(value: string | number | null, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToJob(row: Row): Job {
  const state = String(row.state);
  if (!isJobState(state)) throw new Error(`Corrupt job row: unknown state ${state}`);
  return {
    id: String(row.id),
    repoOwner: String(row.repo_owner),
    repoName: String(row.repo_name),
    issueNumber: Number(row.issue_number),
    issueTitle: String(row.issue_title),
    issueUrl: String(row.issue_url),
    state,
    failureReason: (row.failure_reason as FailureReason | null) ?? null,
    cancelReason: (row.cancel_reason as CancelReason | null) ?? null,
    error: (row.error as string | null) ?? null,
    spriteName: (row.sprite_name as string | null) ?? null,
    spriteId: (row.sprite_id as string | null) ?? null,
    baseBranch: (row.base_branch as string | null) ?? null,
    baseSha: (row.base_sha as string | null) ?? null,
    checkpointId: (row.checkpoint_id as string | null) ?? null,
    workspace: parseJson<WorkspaceInfo | null>(row.workspace, null),
    branchName: (row.branch_name as string | null) ?? null,
    plan: parseJson(row.plan, null),
    planApprovedAt: (row.plan_approved_at as string | null) ?? null,
    planApprovedBy: (row.plan_approved_by as string | null) ?? null,
    testResults: parseJson<TestResult[]>(row.test_results, []),
    execution: parseJson<ExecutionAttempt[]>(row.execution, []),
    baselineResults: parseJson<TestResult[]>(row.baseline_results, []),
    verification: parseJson<Verification | null>(row.verification, null),
    diffHash: (row.diff_hash as string | null) ?? null,
    diff: (row.diff as string | null) ?? null,
    prUrl: (row.pr_url as string | null) ?? null,
    publishApprovedAt: (row.publish_approved_at as string | null) ?? null,
    publishApprovedBy: (row.publish_approved_by as string | null) ?? null,
    publishApprovedHash: (row.publish_approved_hash as string | null) ?? null,
    hasPublishBundle: typeof row.publish_bundle === "string",
    publishResult: parseJson<PublishResult | null>(row.publish_result, null),
    retryCount: Number(row.retry_count),
    attempt: Number(row.attempt),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    stateEnteredAt: String(row.state_entered_at),
    deadlineAt: (row.deadline_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
  };
}

function rowToEvent(row: Row): JobEvent {
  return {
    id: Number(row.id),
    jobId: String(row.job_id),
    at: String(row.at),
    kind: row.kind as JobEventKind,
    fromState: (row.from_state as JobState | null) ?? null,
    toState: (row.to_state as JobState | null) ?? null,
    message: String(row.message),
    data: parseJson(row.data, null),
  };
}

function deadlineFor(state: JobState, now: Date): string | null {
  const ms = STATE_TIMEOUT_MS[state];
  return ms === null ? null : new Date(now.getTime() + ms).toISOString();
}

function sanitizeTestResults(results: TestResult[]): TestResult[] {
  return results.map((r) => ({
    ...r,
    // Never record "passed" without a real zero exit code.
    status: r.status === "passed" && r.exitCode !== 0 ? "failed" : r.status,
    output: sanitizeOutput(r.output, 8_000),
  }));
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: jobs\.active/.test(error.message);
}

export function newJobId(): string {
  return randomBytes(6).toString("hex");
}

export function spriteNameForJob(jobId: string): string {
  return `shipfig-job-${jobId}`;
}

export class JobStore {
  constructor(private readonly db: DatabaseSync) {}

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertEvent(
    jobId: string,
    at: string,
    kind: JobEventKind,
    message: string,
    opts: { from?: JobState | null; to?: JobState | null; data?: unknown } = {},
  ): void {
    this.db
      .prepare("INSERT INTO job_events (job_id, at, kind, from_state, to_state, message, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        jobId,
        at,
        kind,
        opts.from ?? null,
        opts.to ?? null,
        sanitizeOutput(message, MAX_EVENT_CHARS),
        opts.data === undefined ? null : sanitizeOutput(JSON.stringify(opts.data), MAX_EVENT_CHARS),
      );
  }

  /** The current non-terminal job, if any. */
  activeJob(): Job | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE active = 1").get() as Row | undefined;
    return row ? rowToJob(row) : undefined;
  }

  /**
   * Create a queued job for an explicitly selected issue. Rejects if another
   * job is active (checked in the transaction and enforced by a unique index,
   * so concurrent starts cannot both succeed).
   */
  create(input: NewJobInput, now = new Date()): Job {
    const ref = issueRefSchema.parse(input);
    const id = newJobId();
    const at = now.toISOString();
    try {
      this.tx(() => {
        const active = this.activeJob();
        if (active) throw new ActiveJobExistsError(active.id);
        this.db
          .prepare(
            `INSERT INTO jobs (id, repo_owner, repo_name, issue_number, issue_title, issue_url, state, active,
               sprite_name, created_at, updated_at, state_entered_at, deadline_at)
             VALUES (?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            ref.owner,
            ref.repo,
            ref.issueNumber,
            sanitizeOutput(input.issueTitle, 500),
            input.issueUrl,
            spriteNameForJob(id),
            at,
            at,
            at,
            deadlineFor("queued", now),
          );
        this.insertEvent(id, at, "transition", `Job created for ${ref.owner}/${ref.repo}#${ref.issueNumber}`, { to: "queued" });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const active = this.activeJob();
        throw new ActiveJobExistsError(active?.id ?? "unknown");
      }
      throw error;
    }
    return this.get(id);
  }

  find(id: string): Job | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToJob(row) : undefined;
  }

  get(id: string): Job {
    const job = this.find(id);
    if (!job) throw new JobNotFoundError(id);
    return job;
  }

  list(limit = 50): Job[] {
    const rows = this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC, id LIMIT ?").all(limit) as Row[];
    return rows.map(rowToJob);
  }

  events(jobId: string, afterId = 0): JobEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM job_events WHERE job_id = ? AND id > ? ORDER BY id")
      .all(jobId, afterId) as Row[];
    return rows.map(rowToEvent);
  }

  /** Append a non-transition event (sanitized). */
  log(jobId: string, kind: Exclude<JobEventKind, "transition">, message: string, data?: unknown, now = new Date()): void {
    this.get(jobId);
    this.insertEvent(jobId, now.toISOString(), kind, message, { data });
  }

  /**
   * Move a job to a new state, enforcing the transition table, guards and
   * optimistic concurrency. All writes for the change happen in one transaction.
   */
  transition(id: string, to: JobState, options: TransitionOptions = {}): Job {
    const now = options.now ?? new Date();
    const at = now.toISOString();
    try {
      this.tx(() => {
        const job = this.get(id);
        if (options.expectedState && job.state !== options.expectedState) {
          throw new InvalidTransitionError(`Job ${id} is ${job.state}, expected ${options.expectedState}`);
        }
        if (options.expectedVersion !== undefined && job.version !== options.expectedVersion) {
          throw new InvalidTransitionError(`Job ${id} was modified concurrently (version ${job.version} ≠ ${options.expectedVersion})`);
        }
        const canResumePublish = job.failureReason === "publish_error" && job.hasPublishBundle && job.publishApprovedHash === job.diffHash;
        const problem = checkTransition(job.state, to, { retryCount: job.retryCount, attempt: job.attempt, canResumePublish });
        if (problem) throw new InvalidTransitionError(problem);

        const patch = options.patch ?? {};
        const isRepair = job.state === "testing" && to === "editing";
        const isRetry = job.state === "failed" && to === "queued";
        const terminal = isTerminal(to);

        if (to === "failed" && !patch.failureReason) patch.failureReason = "error";
        if (to === "canceled" && !patch.cancelReason) patch.cancelReason = "user_canceled";

        const sets: string[] = [
          "state = ?",
          "active = ?",
          "version = version + 1",
          "updated_at = ?",
          "state_entered_at = ?",
          "deadline_at = ?",
          "finished_at = ?",
        ];
        const values: (string | number | null)[] = [to, terminal ? null : 1, at, at, deadlineFor(to, now), terminal ? at : null];

        if (isRepair) sets.push("retry_count = retry_count + 1");
        if (isRetry) {
          sets.push("attempt = attempt + 1", "retry_count = 0", "failure_reason = NULL", "error = NULL");
        }
        if (job.state === "failed" && to === "publishing") sets.push("failure_reason = NULL", "error = NULL");
        const set = (column: string, value: string | number | null) => {
          sets.push(`${column} = ?`);
          values.push(value);
        };
        if (patch.spriteName !== undefined) set("sprite_name", patch.spriteName);
        if (patch.spriteId !== undefined) set("sprite_id", patch.spriteId);
        if (patch.baseBranch !== undefined) set("base_branch", patch.baseBranch);
        if (patch.baseSha !== undefined) {
          if (!/^[0-9a-f]{40}$/.test(patch.baseSha)) throw new InvalidTransitionError("baseSha must be a full commit SHA");
          set("base_sha", patch.baseSha);
        }
        if (patch.checkpointId !== undefined) set("checkpoint_id", patch.checkpointId);
        if (patch.workspace !== undefined) set("workspace", JSON.stringify(patch.workspace));
        if (patch.branchName !== undefined) set("branch_name", patch.branchName);
        if (patch.plan !== undefined) set("plan", sanitizeOutput(JSON.stringify(patch.plan), MAX_PLAN_CHARS));
        if (patch.planApprovedAt !== undefined) set("plan_approved_at", patch.planApprovedAt);
        if (patch.planApprovedBy !== undefined) set("plan_approved_by", patch.planApprovedBy.slice(0, 200));
        if (patch.testResults !== undefined) set("test_results", JSON.stringify(sanitizeTestResults(patch.testResults)));
        if (patch.execution !== undefined) set("execution", sanitizeOutput(JSON.stringify(patch.execution), MAX_PLAN_CHARS * 2));
        if (patch.baselineResults !== undefined) set("baseline_results", JSON.stringify(sanitizeTestResults(patch.baselineResults)));
        if (patch.verification !== undefined) set("verification", sanitizeOutput(JSON.stringify(patch.verification), MAX_PLAN_CHARS));
        if (patch.diffHash !== undefined) {
          if (!/^[0-9a-f]{64}$/.test(patch.diffHash)) throw new InvalidTransitionError("diffHash must be a sha256 hex digest");
          set("diff_hash", patch.diffHash);
        }
        if (patch.diff !== undefined) set("diff", sanitizeOutput(patch.diff, MAX_DIFF_CHARS));
        if (patch.prUrl !== undefined) set("pr_url", patch.prUrl);
        if (patch.publishApprovedAt !== undefined) set("publish_approved_at", patch.publishApprovedAt);
        if (patch.publishApprovedBy !== undefined) set("publish_approved_by", patch.publishApprovedBy.slice(0, 200));
        if (patch.publishApprovedHash !== undefined) {
          if (!/^[0-9a-f]{64}$/.test(patch.publishApprovedHash)) throw new InvalidTransitionError("publishApprovedHash must be a sha256 hex digest");
          set("publish_approved_hash", patch.publishApprovedHash);
        }
        if (patch.publishResult !== undefined) set("publish_result", JSON.stringify(patch.publishResult));
        if (patch.publishBundle !== undefined) {
          if (patch.diffHash !== undefined && patch.publishBundle.diffHash !== patch.diffHash) {
            throw new InvalidTransitionError("The publish bundle does not match the recorded diff");
          }
          set("publish_bundle", JSON.stringify(patch.publishBundle));
        }
        if (patch.error !== undefined) set("error", sanitizeOutput(patch.error, MAX_ERROR_CHARS));
        if (patch.failureReason !== undefined) set("failure_reason", patch.failureReason);
        if (patch.cancelReason !== undefined) set("cancel_reason", patch.cancelReason);

        const result = this.db
          .prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ? AND version = ?`)
          .run(...values, id, job.version);
        if (result.changes !== 1) throw new InvalidTransitionError(`Job ${id} was modified concurrently`);

        const reason = to === "failed" ? ` (${patch.failureReason})` : to === "canceled" ? ` (${patch.cancelReason})` : "";
        const message = options.message ?? `${job.state} → ${to}${reason}`;
        this.insertEvent(id, at, "transition", message, {
          from: job.state,
          to,
          data: patch.error ? { error: patch.error } : undefined,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const active = this.activeJob();
        throw new ActiveJobExistsError(active?.id ?? "unknown");
      }
      throw error;
    }
    return this.get(id);
  }

  cancel(id: string, reason: CancelReason = "user_canceled", now = new Date()): Job {
    return this.transition(id, "canceled", { patch: { cancelReason: reason }, now });
  }

  fail(id: string, error: string, reason: FailureReason = "error", now = new Date()): Job {
    return this.transition(id, "failed", { patch: { error, failureReason: reason }, now });
  }

  /**
   * Approve the plan currently shown to the user. `expectedVersion` must match
   * the version the user saw, so a plan that changed since cannot be approved.
   */
  approvePlan(id: string, expectedVersion: number, approvedBy: string, now = new Date()): Job {
    const job = this.get(id);
    const plan = job.plan as { plan?: { needsClarification?: boolean } } | null;
    if (!plan?.plan) throw new InvalidTransitionError(`Job ${id} has no plan to approve`);
    if (plan.plan.needsClarification) throw new InvalidTransitionError("This plan needs clarification and cannot be approved");
    return this.transition(id, "editing", {
      expectedState: "awaiting_plan_approval",
      expectedVersion,
      message: `Plan approved by ${approvedBy}`,
      patch: { planApprovedAt: now.toISOString(), planApprovedBy: approvedBy },
      now,
    });
  }

  rejectPlan(id: string, expectedVersion: number, now = new Date()): Job {
    return this.transition(id, "canceled", {
      expectedState: "awaiting_plan_approval",
      expectedVersion,
      message: "Plan rejected",
      patch: { cancelReason: "plan_rejected" },
      now,
    });
  }

  /**
   * Approve publishing the exact diff the user reviewed. The diff hash must
   * match the one Shipfig recorded, checks must not have failed, and a change
   * with missing checks ("unverified") needs an explicit acknowledgement.
   */
  approvePublish(
    id: string,
    input: { expectedVersion: number; diffHash: string; approvedBy: string; acknowledgeUnverified?: boolean },
    now = new Date(),
  ): Job {
    const job = this.get(id);
    if (job.state !== "awaiting_publish_approval") throw new InvalidTransitionError(`Job ${id} is ${job.state}, not awaiting publish approval`);
    if (!job.diffHash || input.diffHash !== job.diffHash) {
      throw new InvalidTransitionError("The approved diff does not match the diff Shipfig recorded; reload the job and review it again");
    }
    const outcome = job.verification?.outcome;
    if (outcome !== "verified" && outcome !== "unverified") throw new InvalidTransitionError("Only a change whose checks passed can be published");
    if (outcome === "unverified" && !input.acknowledgeUnverified) {
      throw new InvalidTransitionError("Some requested checks could not run; acknowledge that the change is unverified to publish it");
    }
    return this.transition(id, "publishing", {
      expectedState: "awaiting_publish_approval",
      expectedVersion: input.expectedVersion,
      message: `Publishing approved by ${input.approvedBy} for diff ${input.diffHash.slice(0, 12)}${outcome === "unverified" ? " (unverified, acknowledged)" : ""}`,
      patch: { publishApprovedAt: now.toISOString(), publishApprovedBy: input.approvedBy, publishApprovedHash: input.diffHash },
      now,
    });
  }

  rejectPublish(id: string, expectedVersion: number, now = new Date()): Job {
    return this.transition(id, "canceled", {
      expectedState: "awaiting_publish_approval",
      expectedVersion,
      message: "Publishing rejected",
      patch: { cancelReason: "publish_rejected" },
      now,
    });
  }

  /** The saved publish bundle, if any. Kept off the Job object: it holds file contents. */
  publishBundle(id: string): PublishBundle | null {
    const row = this.db.prepare("SELECT publish_bundle FROM jobs WHERE id = ?").get(id) as { publish_bundle: string | null } | undefined;
    if (!row) throw new JobNotFoundError(id);
    return parseJson<PublishBundle | null>(row.publish_bundle, null);
  }

  /** Save the bundle while publishing (jobs verified before bundles were frozen at verification). Stored verbatim. */
  savePublishBundle(id: string, bundle: PublishBundle, now = new Date()): void {
    const result = this.db
      .prepare("UPDATE jobs SET publish_bundle = ?, updated_at = ? WHERE id = ? AND state = 'publishing' AND publish_approved_hash = ?")
      .run(JSON.stringify(bundle), now.toISOString(), id, bundle.diffHash);
    if (result.changes !== 1) throw new InvalidTransitionError(`Job ${id} is not publishing the approved diff ${bundle.diffHash.slice(0, 12)}`);
  }

  /**
   * Retry a failed job. A failed publish with a saved bundle resumes
   * publishing (same approved diff); anything else re-queues the whole job
   * (bounded by MAX_ATTEMPTS and the one-active-job rule).
   */
  retry(id: string, now = new Date()): Job {
    const job = this.get(id);
    if (job.state === "failed" && job.failureReason === "publish_error" && job.hasPublishBundle) {
      return this.transition(id, "publishing", { expectedState: "failed", message: "Retrying publish of the approved diff", now });
    }
    return this.transition(id, "queued", { expectedState: "failed", message: "Retry requested", now });
  }

  /**
   * Fail every active job whose state deadline has passed. Called on reads and
   * by the worker so timeouts are explicit even after a process restart.
   */
  expireTimedOut(now = new Date()): Job[] {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE active = 1 AND deadline_at IS NOT NULL AND deadline_at <= ?")
      .all(now.toISOString()) as Row[];
    const expired: Job[] = [];
    for (const row of rows) {
      const job = rowToJob(row);
      try {
        expired.push(
          this.transition(job.id, "failed", {
            expectedVersion: job.version,
            message: `Timed out in ${job.state} (deadline ${job.deadlineAt})`,
            patch: { failureReason: "timeout", error: `Timed out while ${job.state}` },
            now,
          }),
        );
      } catch (error) {
        if (!(error instanceof InvalidTransitionError)) throw error;
        // Raced with a legitimate transition; leave it.
      }
    }
    return expired;
  }
}

let store: JobStore | undefined;

export function jobStore(): JobStore {
  store ??= new JobStore(database());
  return store;
}
