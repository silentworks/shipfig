import { AgentLimitError, AgentOutputError, AgentStoppedError } from "@/lib/agent/loop";
import { type AgentModel, agentModel } from "@/lib/agent/model";
import { executePlan } from "@/lib/agent/executor";
import { type PlanRecord, planIssue } from "@/lib/agent/planner";
import { policyViolations } from "@/lib/agent/policy";
import { changedFiles, runChecks } from "@/lib/verify/checks";
import { getAllowedIssue, getAllowedRepo, getBranchHeadSha } from "@/lib/github/connector";
import type { Issue } from "@/lib/github/schemas";
import { redact } from "@/lib/redact";
import { type Sandbox, createJobSandbox, destroyJobSandbox, openJobSandbox } from "@/lib/sprites/sandbox";
import { type ProvisionDeps, SetupError, provisionWorkspace } from "@/lib/workspace/provision";
import type { FailureReason, JobState } from "./states";
import { MAX_REPAIR_ATTEMPTS, isTerminal } from "./states";
import { InvalidTransitionError, type Job, type JobStore, jobStore } from "./store";

/**
 * In-process job orchestrator (single-instance MVP). `kickJob` drives a job
 * through its automated states until it reaches a human gate (plan or publish
 * approval), a state with no stage yet, or a terminal state. Every step goes
 * through the guarded store transitions, so a concurrent cancel simply makes
 * the next transition fail and the runner stops.
 */

export interface RunnerDeps {
  store: JobStore;
  getAllowedRepo: ProvisionDeps["getAllowedRepo"];
  getBranchHeadSha: ProvisionDeps["getBranchHeadSha"];
  getAllowedIssue(ref: { owner: string; repo: string; issueNumber: number }): Promise<Issue>;
  /** Lazily resolved so a missing OPENAI_API_KEY only matters once planning starts. */
  model(): AgentModel;
  createSandbox(name: string): Promise<Sandbox>;
  openSandbox(name: string): Promise<Sandbox | undefined>;
  destroySandbox(name: string): Promise<boolean>;
}

export interface StageContext {
  deps: RunnerDeps;
  /** The job's sandbox (cached; reattached after a restart). */
  sandbox(): Promise<Sandbox>;
  log(kind: "info" | "command" | "error", message: string, data?: unknown): void;
}

type Stage = (job: Job, ctx: StageContext) => Promise<void>;

/** Raised by a stage to fail the job with a specific reason. */
export class StageError extends Error {
  constructor(
    public readonly reason: FailureReason,
    message: string,
  ) {
    super(message);
    this.name = "StageError";
  }
}

const sandboxes = new Map<string, Sandbox>();

const stages: Partial<Record<JobState, Stage>> = {
  async queued(job, { deps }) {
    deps.store.transition(job.id, "provisioning", { expectedState: "queued", expectedVersion: job.version });
  },

  async provisioning(job, ctx) {
    const { store } = ctx.deps;
    try {
      const result = await provisionWorkspace(
        { jobId: job.id, owner: job.repoOwner, repo: job.repoName, issueNumber: job.issueNumber, spriteName: job.spriteName ?? "" },
        { ...ctx.deps, log: (kind, message, data) => ctx.log(kind, message, data) },
      );
      sandboxes.set(job.id, result.sandbox);
      store.transition(job.id, "planning", {
        expectedState: "provisioning",
        message: `Workspace ready on ${result.branchName} at ${result.baseSha.slice(0, 12)} (checkpoint ${result.checkpointId})`,
        patch: {
          spriteId: result.spriteId,
          baseBranch: result.baseBranch,
          baseSha: result.baseSha,
          branchName: result.branchName,
          checkpointId: result.checkpointId,
          workspace: result.workspace,
        },
      });
    } catch (error) {
      if (error instanceof SetupError) throw new StageError("setup_error", `Setup failed at ${error.step}: ${error.message}`);
      throw error;
    }
  },
};

function agentFailure(error: unknown): never {
  if (error instanceof AgentStoppedError) throw new InvalidTransitionError(error.message);
  if (error instanceof AgentLimitError || error instanceof AgentOutputError) throw new StageError("agent_error", error.message);
  throw error;
}

/** Stop agent loops as soon as the job leaves the state they belong to. */
function stopUnless(store: JobStore, jobId: string, state: JobState) {
  return () => {
    const current = store.find(jobId)?.state;
    return current === state ? null : `job is now ${current}`;
  };
}

stages.planning = async (job, ctx) => {
  const { store } = ctx.deps;
  if (!job.workspace) throw new StageError("setup_error", "Job has no workspace; provisioning did not complete");
  const sandbox = await ctx.sandbox();
  // Re-fetch the issue server-side: the plan is based on its current text.
  const issue = await ctx.deps.getAllowedIssue({ owner: job.repoOwner, repo: job.repoName, issueNumber: job.issueNumber });
  if (issue.state !== "open") throw new StageError("error", `Issue #${issue.number} is ${issue.state}`);
  const model = ctx.deps.model();
  ctx.log("info", `Planning with ${model.name}`);
  const record = await planIssue({
    sandbox,
    workspace: job.workspace,
    issue,
    repoSlug: `${job.repoOwner}/${job.repoName}`,
    model,
    onEvent: (e) => ctx.log("info", `planner ${e.kind === "tool_error" ? "error: " : ""}${e.message}`),
    shouldStop: stopUnless(store, job.id, "planning"),
  }).catch(agentFailure);

  if (record.plan.needsClarification) {
    store.transition(job.id, "failed", {
      expectedState: "planning",
      message: "Planner needs clarification before any change",
      patch: {
        plan: record,
        failureReason: "needs_clarification",
        error: `Needs clarification: ${record.plan.clarificationQuestion ?? "the issue is ambiguous or out of scope"}`,
      },
    });
    return;
  }
  store.transition(job.id, "awaiting_plan_approval", {
    expectedState: "planning",
    message: `Plan ready: ${record.plan.files.length} file(s), checks ${record.runnableChecks.join(", ") || "none"}`,
    patch: { plan: record },
  });
};

function approvedPlan(job: Job): PlanRecord {
  const record = job.plan as PlanRecord | null;
  if (!record?.plan || !job.planApprovedAt) throw new StageError("error", "Job has no approved plan");
  return record;
}

/**
 * editing: run the executor on the approved plan. On a repair attempt the
 * failing check output from the previous testing stage is passed back.
 */
stages.editing = async (job, ctx) => {
  const { store } = ctx.deps;
  if (!job.workspace) throw new StageError("setup_error", "Job has no workspace");
  const plan = approvedPlan(job);
  const sandbox = await ctx.sandbox();
  const issue = await ctx.deps.getAllowedIssue({ owner: job.repoOwner, repo: job.repoName, issueNumber: job.issueNumber });
  const repair = job.retryCount > 0 ? { attempt: job.retryCount, failures: job.testResults.filter((r) => r.status !== "passed") } : undefined;
  const model = ctx.deps.model();
  ctx.log("info", repair ? `Repair attempt ${repair.attempt} of ${MAX_REPAIR_ATTEMPTS}` : `Editing with ${model.name}`);
  const startedAt = new Date().toISOString();
  const { report, session, usage } = await executePlan({
    sandbox,
    workspace: job.workspace,
    issue,
    plan,
    model,
    repair,
    onEvent: (e) => ctx.log(e.kind === "tool_error" ? "error" : "info", `executor ${e.message}`),
    shouldStop: stopUnless(store, job.id, "editing"),
  }).catch(agentFailure);

  const attempt = {
    attempt: job.retryCount,
    startedAt,
    finishedAt: new Date().toISOString(),
    report,
    filesWritten: [...session.written],
    refusals: session.refusals,
    agentCheckRuns: session.checkRuns.map((r) => ({ name: r.name, status: r.status, exitCode: r.exitCode })),
    usage,
  };
  store.transition(job.id, "testing", {
    expectedState: "editing",
    message: `Executor wrote ${session.written.size} file(s)${session.refusals.length ? `, ${session.refusals.length} write(s) refused by policy` : ""}`,
    patch: { execution: [...job.execution, attempt] },
  });
};

/**
 * testing: Shipfig (not the model) re-runs the approved checks and decides.
 * Failed checks go back to editing at most MAX_REPAIR_ATTEMPTS times.
 */
stages.testing = async (job, ctx) => {
  const { store } = ctx.deps;
  if (!job.workspace) throw new StageError("setup_error", "Job has no workspace");
  const plan = approvedPlan(job);
  const sandbox = await ctx.sandbox();
  const root = job.workspace.root;

  const files = await changedFiles(sandbox, root);
  if (files.length === 0) throw new StageError("no_changes", "The executor made no changes to the repository");
  const violations = policyViolations(files);
  if (violations.length > 0) {
    throw new StageError("policy_violation", `Protected files changed: ${violations.map((v) => `${v.path} (${v.reason})`).join("; ")}`);
  }

  const results = await runChecks(sandbox, root, plan.runnableChecks);
  for (const r of results) {
    ctx.log("command", `$ ${r.command.join(" ")} → ${r.status === "timed_out" ? "timed out" : `exit ${r.exitCode}`} (${((r.durationMs ?? 0) / 1000).toFixed(1)}s)`, {
      exitCode: r.exitCode,
      durationMs: r.durationMs,
    });
  }
  const failed = results.filter((r) => r.status !== "passed");
  await sandbox.run(["git", "add", "--intent-to-add", "--all"], { cwd: root, timeoutMs: 30_000 });
  const diff = (await sandbox.run(["git", "diff", "--no-color", "--no-ext-diff", "HEAD"], { cwd: root, timeoutMs: 30_000, maxOutputChars: 200_000 })).stdout;

  if (failed.length === 0) {
    store.transition(job.id, "awaiting_publish_approval", {
      expectedState: "testing",
      message: results.length > 0 ? `All ${results.length} check(s) passed on ${files.length} changed file(s)` : `No runnable checks; ${files.length} changed file(s) are unverified`,
      patch: { testResults: results, diff },
    });
  } else if (job.retryCount < MAX_REPAIR_ATTEMPTS) {
    store.transition(job.id, "editing", {
      expectedState: "testing",
      message: `${failed.map((f) => f.name).join(", ")} failed; starting repair attempt ${job.retryCount + 1} of ${MAX_REPAIR_ATTEMPTS}`,
      patch: { testResults: results, diff },
    });
  } else {
    store.transition(job.id, "failed", {
      expectedState: "testing",
      message: `Checks still failing after ${MAX_REPAIR_ATTEMPTS} repair attempts`,
      patch: {
        testResults: results,
        diff,
        failureReason: "repair_limit",
        error: `${failed.map((f) => `${f.command.join(" ")} ${f.status === "timed_out" ? "timed out" : `exited ${f.exitCode}`}`).join("; ")} after ${MAX_REPAIR_ATTEMPTS} repair attempts`,
      },
    });
  }
};

/** Register (or replace) the stage for a state. Later milestones plug in here. */
export function registerStage(state: JobState, stage: Stage): void {
  stages[state] = stage;
}

export function defaultRunnerDeps(): RunnerDeps {
  return {
    store: jobStore(),
    getAllowedRepo,
    getBranchHeadSha,
    getAllowedIssue,
    model: agentModel,
    createSandbox: createJobSandbox,
    openSandbox: openJobSandbox,
    destroySandbox: destroyJobSandbox,
  };
}

function contextFor(jobId: string, deps: RunnerDeps): StageContext {
  return {
    deps,
    log: (kind, message, data) => deps.store.log(jobId, kind, message, data),
    async sandbox() {
      const cached = sandboxes.get(jobId);
      if (cached) return cached;
      const job = deps.store.get(jobId);
      const reopened = job.spriteName ? await deps.openSandbox(job.spriteName) : undefined;
      if (!reopened) throw new StageError("sprite_error", `Sprite ${job.spriteName} for job ${jobId} no longer exists`);
      sandboxes.set(jobId, reopened);
      return reopened;
    },
  };
}

/** Delete the job's sprite once the job is terminal. Never throws. */
async function cleanup(job: Job, deps: RunnerDeps): Promise<void> {
  sandboxes.delete(job.id);
  if (!job.spriteName) return;
  try {
    if (await deps.destroySandbox(job.spriteName)) deps.store.log(job.id, "info", `Deleted sprite ${job.spriteName}`);
  } catch (error) {
    deps.store.log(job.id, "error", `Could not delete sprite ${job.spriteName}: ${(error as Error).message}`);
  }
}

/** Advance a job until it needs a human, has no stage for its state, or ends. */
export async function runJob(jobId: string, deps: RunnerDeps = defaultRunnerDeps()): Promise<Job> {
  const ctx = contextFor(jobId, deps);
  for (let guard = 0; guard < 50; guard++) {
    deps.store.expireTimedOut();
    const job = deps.store.get(jobId);
    if (isTerminal(job.state)) {
      await cleanup(job, deps);
      return job;
    }
    const stage = stages[job.state];
    if (!stage) return job; // awaiting a human, or not implemented yet
    try {
      await stage(job, ctx);
    } catch (error) {
      if (error instanceof InvalidTransitionError) continue; // canceled/expired meanwhile: re-read
      const reason: FailureReason = error instanceof StageError ? error.reason : "error";
      const message = redact(error instanceof Error ? error.message : String(error));
      try {
        deps.store.fail(jobId, message, reason);
      } catch (failError) {
        if (!(failError instanceof InvalidTransitionError)) throw failError;
      }
      continue;
    }
    if (deps.store.get(jobId).version === job.version) return deps.store.get(jobId); // stage made no progress
  }
  throw new Error(`Job ${jobId} did not settle`);
}

const globalRunner = globalThis as unknown as { __shipfigRunning?: Map<string, Promise<Job>> };

/**
 * Start (or join) the runner for a job in the background. Safe to call
 * repeatedly; only one runner per job runs at a time in this process.
 */
export function kickJob(jobId: string, deps?: RunnerDeps): Promise<Job> {
  const running = (globalRunner.__shipfigRunning ??= new Map());
  const existing = running.get(jobId);
  if (existing) return existing;
  const promise = runJob(jobId, deps)
    .catch((error) => {
      console.error(`[shipfig] runner for job ${jobId} crashed:`, redact((error as Error).stack ?? String(error)));
      throw error;
    })
    .finally(() => running.delete(jobId));
  running.set(jobId, promise);
  return promise;
}
