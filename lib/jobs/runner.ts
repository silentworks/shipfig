import { AgentLimitError, AgentOutputError, AgentStoppedError } from "@/lib/agent/loop";
import { type AgentModel, agentModel } from "@/lib/agent/model";
import { executePlan } from "@/lib/agent/executor";
import { type PlanRecord, planIssue } from "@/lib/agent/planner";
import { policyViolations } from "@/lib/agent/policy";
import { changedFiles, runChecks } from "@/lib/verify/checks";
import { type Verification, captureDiff, evidenceFlags, missingCheckResults, secretsInPatch, verificationOutcome } from "@/lib/verify/evidence";
import { reviewChanges } from "@/lib/verify/review";
import { getAllowedIssue, getAllowedRepo, getBranchHeadSha } from "@/lib/github/connector";
import { PublishConflictError, publishBundleToGitHub } from "@/lib/github/publish";
import { resolveJobGitHubRequest } from "@/lib/github/user-client";
import { getUserSelectedRepos } from "@/lib/github/user-repos";
import { BundleError, collectBundle } from "@/lib/publish/bundle";
import { commitMessage, pullRequestBody, pullRequestTitle } from "@/lib/publish/pr-body";
import type { Issue } from "@/lib/github/schemas";
import { redact } from "@/lib/redact";
import { type Sandbox, createJobSandbox, destroyJobSandbox, openJobSandbox } from "@/lib/sprites/sandbox";
import { type ProvisionDeps, SetupError, provisionWorkspace } from "@/lib/workspace/provision";
import type { FailureReason, JobState } from "./states";
import { MAX_REPAIR_ATTEMPTS, isTerminal } from "./states";
import { classifyStageError, tidyMessage } from "./errors";
import { InvalidTransitionError, type Job, type JobStore, type TestResult, jobStore } from "./store";

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
  /** Writes the approved bundle to GitHub (branch + draft PR) via the trusted gateway. */
  publish: typeof publishBundleToGitHub;
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

  // Baseline: run the approved checks on the untouched checkout first, so a
  // pre-existing failure is not mistaken for (or hidden by) the change.
  let baselineResults: TestResult[] | undefined;
  if (!repair && job.execution.length === 0 && plan.runnableChecks.length > 0) {
    baselineResults = await runChecks(sandbox, job.workspace.root, plan.runnableChecks);
    for (const r of baselineResults) ctx.log("command", `baseline $ ${r.command.join(" ")} → ${r.status === "timed_out" ? "timed out" : `exit ${r.exitCode}`}${r.summary ? ` · ${r.summary}` : ""}`);
  }

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
    patch: { execution: [...job.execution, attempt], ...(baselineResults ? { baselineResults } : {}) },
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

  // Shipfig runs the checks itself; outcomes come only from exit codes.
  const ran = await runChecks(sandbox, root, plan.runnableChecks);
  for (const r of ran) {
    ctx.log("command", `$ ${r.command.join(" ")} → ${r.status === "timed_out" ? "timed out" : `exit ${r.exitCode}`} (${((r.durationMs ?? 0) / 1000).toFixed(1)}s)${r.summary ? ` · ${r.summary}` : ""}`, {
      exitCode: r.exitCode,
      durationMs: r.durationMs,
    });
  }
  const results = [...ran, ...missingCheckResults(plan.missingChecks)];
  const diff = await captureDiff(sandbox, root);
  const flags = evidenceFlags({ diff, plan, baseline: job.baselineResults, results });
  const outcome = verificationOutcome(results, plan.missingChecks);
  const verification = (review: Verification["review"], reviewError: string | null): Verification => ({
    outcome,
    missingChecks: plan.missingChecks,
    baseline: job.baselineResults,
    diff: { files: diff.files, additions: diff.additions, deletions: diff.deletions, hash: diff.hash, truncated: diff.truncated },
    regressionTestChanged: !flags.some((f) => f.startsWith("No test file")),
    flags,
    review,
    reviewError,
    createdAt: new Date().toISOString(),
  });
  const evidence = { testResults: results, diff: diff.patch, diffHash: diff.hash };

  if (outcome === "failed") {
    const failed = ran.filter((r) => r.status !== "passed");
    if (job.retryCount < MAX_REPAIR_ATTEMPTS) {
      store.transition(job.id, "editing", {
        expectedState: "testing",
        message: `${failed.map((f) => f.name).join(", ")} failed; starting repair attempt ${job.retryCount + 1} of ${MAX_REPAIR_ATTEMPTS}`,
        patch: { ...evidence, verification: verification(null, null) },
      });
    } else {
      store.transition(job.id, "failed", {
        expectedState: "testing",
        message: `Checks still failing after ${MAX_REPAIR_ATTEMPTS} repair attempts`,
        patch: {
          ...evidence,
          verification: verification(null, null),
          failureReason: "repair_limit",
          error: `${failed.map((f) => `${f.command.join(" ")} ${f.status === "timed_out" ? "timed out" : `exited ${f.exitCode}`}`).join("; ")} after ${MAX_REPAIR_ATTEMPTS} repair attempts`,
        },
      });
    }
    return;
  }

  // Server-side policy on the final diff.
  const secretFiles = secretsInPatch(diff.patch);
  if (secretFiles.length > 0) {
    store.transition(job.id, "failed", {
      expectedState: "testing",
      patch: { ...evidence, verification: verification(null, null), failureReason: "policy_violation", error: `The change adds what looks like a secret in: ${secretFiles.join(", ")}` },
    });
    return;
  }

  // Model review: can block, never approve.
  let review: Verification["review"] = null;
  let reviewError: string | null = null;
  try {
    const issue = await ctx.deps.getAllowedIssue({ owner: job.repoOwner, repo: job.repoName, issueNumber: job.issueNumber });
    review = await reviewChanges({ model: ctx.deps.model(), issue, plan, patch: diff.patch, results, flags });
  } catch (error) {
    reviewError = redact((error as Error).message).slice(0, 500);
    ctx.log("error", `Review unavailable: ${reviewError}`);
  }
  if (review?.verdict === "fail") {
    store.transition(job.id, "failed", {
      expectedState: "testing",
      message: "Verification review rejected the change",
      patch: { ...evidence, verification: verification(review, reviewError), failureReason: "review_failed", error: `Review: ${review.concerns.join("; ") || "rejected"}` },
    });
    return;
  }
  // Freeze the exact change now, bound to the diff hash the human will approve,
  // so publishing never depends on this sprite still being reachable.
  let publishBundle;
  try {
    publishBundle = await collectBundle(sandbox, root, { diffHash: diff.hash, baseSha: job.baseSha!, baseBranch: job.baseBranch!, branchName: job.branchName! });
  } catch (error) {
    if (!(error instanceof BundleError)) throw error;
    store.transition(job.id, "failed", {
      expectedState: "testing",
      patch: { ...evidence, verification: verification(review, reviewError), failureReason: "policy_violation", error: `This change cannot be published: ${error.message}` },
    });
    return;
  }
  const label = outcome === "verified" ? `all ${ran.length} check(s) passed` : ran.length > 0 ? `checks passed, but ${plan.missingChecks.join(", ")} could not run` : "no checks could run";
  store.transition(job.id, "awaiting_publish_approval", {
    expectedState: "testing",
    message: `${outcome === "verified" ? "Verified" : "Unverified"}: ${label}; ${diff.files.length} file(s), +${diff.additions}/-${diff.deletions}`,
    patch: { ...evidence, verification: verification(review, reviewError), publishBundle },
  });
};

/**
 * publishing (SIL-534): only after an approval, loaded from the job record,
 * of the exact recorded diff. The change was frozen into a bundle at
 * verification time (same diff hash), so this needs no sprite; it is written
 * to GitHub through the trusted gateway as a branch and a draft PR.
 */
stages.publishing = async (job, ctx) => {
  const { store } = ctx.deps;
  if (!job.diffHash || !job.publishApprovedAt || job.publishApprovedHash !== job.diffHash) {
    throw new StageError("policy_violation", "Publishing requires an approval of the exact recorded diff");
  }
  const outcome = job.verification?.outcome;
  if (outcome !== "verified" && outcome !== "unverified") throw new StageError("policy_violation", "Only a change whose checks passed can be published");
  if (!job.baseSha || !job.baseBranch || !job.branchName) throw new StageError("publish_error", "The job has no pinned base commit or branch");
  const plan = approvedPlan(job);
  const ref = { owner: job.repoOwner, repo: job.repoName };

  let bundle = store.publishBundle(job.id);
  if (!bundle) {
    // Jobs verified before bundles were frozen at verification time.
    if (!job.workspace) throw new StageError("setup_error", "Job has no workspace");
    const sandbox = await ctx.sandbox();
    try {
      bundle = await collectBundle(sandbox, job.workspace.root, { diffHash: job.diffHash, baseSha: job.baseSha, baseBranch: job.baseBranch, branchName: job.branchName });
    } catch (error) {
      if (error instanceof BundleError) throw new StageError("policy_violation", error.message);
      throw error;
    }
    store.savePublishBundle(job.id, bundle);
    ctx.log("info", `Saved the approved change for publishing: ${bundle.files.length} file(s), diff ${bundle.diffHash.slice(0, 12)}`);
  } else {
    ctx.log("info", `Publishing the verified change (${bundle.files.length} file(s), diff ${bundle.diffHash.slice(0, 12)})`);
  }
  if (bundle.diffHash !== job.publishApprovedHash) throw new StageError("policy_violation", "The saved change does not match the approved diff");

  let result;
  try {
    await ctx.deps.getAllowedRepo(ref);
    result = await ctx.deps.publish(
      ref,
      bundle,
      ({ baseMoved }) => ({ title: pullRequestTitle(job), body: pullRequestBody(job, plan, { baseMoved }), commitMessage: commitMessage(job, plan) }),
      { log: (message) => ctx.log("info", message) },
    );
  } catch (error) {
    const message = redact((error as Error).message);
    const hint = error instanceof PublishConflictError ? "" : " Retry to resume from the saved change; nothing will be duplicated.";
    throw new StageError("publish_error", `Publishing failed: ${message}.${hint}`);
  }
  store.transition(job.id, "completed", {
    expectedState: "publishing",
    message: `${result.reused.pullRequest ? "Reused" : "Opened"} ${result.draft ? "draft " : ""}PR #${result.prNumber}: ${result.prUrl}`,
    patch: { prUrl: result.prUrl, publishResult: result },
  });
};

/** Register (or replace) the stage for a state. Later milestones plug in here. */
export function registerStage(state: JobState, stage: Stage): void {
  stages[state] = stage;
}

export function defaultRunnerDeps(jobId?: string): RunnerDeps {
  const store = jobStore();
  const jobContext = async () => {
    const job = jobId ? store.find(jobId) : undefined;
    const userId = job?.createdByUserId ?? null;
    const [request, selectedRepos] = await Promise.all([
      resolveJobGitHubRequest(userId),
      userId ? getUserSelectedRepos(userId) : Promise.resolve([]),
    ]);
    return { request, selectedRepos };
  };
  return {
    store,
    async getAllowedRepo(ref) {
      const { request, selectedRepos } = await jobContext();
      return getAllowedRepo(ref, request, selectedRepos);
    },
    async getBranchHeadSha(ref, branch) {
      const { request } = await jobContext();
      return getBranchHeadSha(ref, branch, request);
    },
    async getAllowedIssue(ref) {
      const { request, selectedRepos } = await jobContext();
      return getAllowedIssue(ref, request, selectedRepos);
    },
    model: agentModel,
    createSandbox: createJobSandbox,
    openSandbox: openJobSandbox,
    destroySandbox: destroyJobSandbox,
    async publish(ref, bundle, draft, options) {
      const { request } = await jobContext();
      return publishBundleToGitHub(ref, bundle, draft, { ...options, request: options?.request ?? request });
    },
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
export async function runJob(jobId: string, deps: RunnerDeps = defaultRunnerDeps(jobId)): Promise<Job> {
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
      const classified = error instanceof StageError ? { reason: error.reason, message: tidyMessage(error.message) } : classifyStageError(error);
      const reason: FailureReason = classified.reason;
      const message = classified.message;
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
