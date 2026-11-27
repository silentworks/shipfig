import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "@/lib/jobs/db";
import { runJob, type RunnerDeps } from "@/lib/jobs/runner";
import { JOB_STATES, MAX_ATTEMPTS, MAX_REPAIR_ATTEMPTS, TRANSITIONS, type JobState } from "@/lib/jobs/states";
import { InvalidTransitionError, JobStore, MAX_QUEUED_JOBS, QueueFullError } from "@/lib/jobs/store";

const input = {
  owner: "acme",
  repo: "web",
  issueNumber: 7,
  issueTitle: "Button crashes",
  issueUrl: "https://github.com/acme/web/issues/7",
};

const happyPath: JobState[] = [
  "provisioning",
  "planning",
  "awaiting_plan_approval",
  "editing",
  "testing",
  "awaiting_publish_approval",
  "publishing",
  "completed",
];

let store: JobStore;
beforeEach(() => {
  store = new JobStore(openDatabase(":memory:"));
});

describe("job lifecycle", () => {
  it("covers every PRD state", () => {
    expect(JOB_STATES).toEqual([
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
    ]);
  });

  it("runs the happy path and records every transition", () => {
    const job = store.create(input);
    expect(job.state).toBe("queued");
    expect(job.spriteName).toBe(`shipfig-job-${job.id}`);
    for (const state of happyPath) store.transition(job.id, state);
    const done = store.get(job.id);
    expect(done.state).toBe("completed");
    expect(done.finishedAt).not.toBeNull();
    expect(done.version).toBe(1 + happyPath.length);
    const transitions = store.events(job.id).filter((e) => e.kind === "transition");
    expect(transitions.map((e) => e.toState)).toEqual(["queued", ...happyPath]);
    expect(store.activeJob()).toBeUndefined();
  });

  it("rejects every transition not in the table", () => {
    for (const from of JOB_STATES) {
      for (const to of JOB_STATES) {
        if (TRANSITIONS[from].includes(to)) continue;
        const s = new JobStore(openDatabase(":memory:"));
        const job = s.create(input);
        // Force the job into `from` via a legal path where one exists.
        const path = pathTo(from);
        if (!path) continue;
        for (const step of path) s.transition(job.id, step);
        expect(() => s.transition(job.id, to), `${from} → ${to}`).toThrow(InvalidTransitionError);
      }
    }
  });

  it("enforces expectedState and expectedVersion", () => {
    const job = store.create(input);
    expect(() => store.transition(job.id, "provisioning", { expectedState: "testing" })).toThrow(InvalidTransitionError);
    expect(() => store.transition(job.id, "provisioning", { expectedVersion: job.version + 1 })).toThrow(InvalidTransitionError);
    expect(store.transition(job.id, "provisioning", { expectedVersion: job.version }).state).toBe("provisioning");
  });

  it("does not allow cancel while publishing", () => {
    const job = store.create(input);
    for (const state of happyPath.slice(0, 7)) store.transition(job.id, state);
    expect(() => store.cancel(job.id)).toThrow(InvalidTransitionError);
  });

  it("records explicit cancel and fail reasons", () => {
    const a = store.create(input);
    store.transition(a.id, "provisioning");
    store.transition(a.id, "planning");
    store.transition(a.id, "awaiting_plan_approval");
    const canceled = store.cancel(a.id, "plan_rejected");
    expect(canceled).toMatchObject({ state: "canceled", cancelReason: "plan_rejected" });

    const b = store.create(input);
    const failed = store.fail(b.id, "sprite exploded with token ghp_" + "x".repeat(36), "sprite_error");
    expect(failed).toMatchObject({ state: "failed", failureReason: "sprite_error" });
    expect(failed.error).not.toContain("ghp_");
  });
});

describe("one active job & FIFO queue", () => {
  it("queues additional jobs behind the active job and promotes them in FIFO order", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const t1 = new Date("2026-01-01T00:01:00Z");
    const t2 = new Date("2026-01-01T00:02:00Z");
    const first = store.create(input, t0);
    const second = store.create({ ...input, issueNumber: 8 }, t1);
    const third = store.create({ ...input, issueNumber: 9 }, t2);

    expect(store.activeJob()?.id).toBe(first.id);
    expect(store.queuedJobs().map((j) => j.id)).toEqual([second.id, third.id]);
    expect(store.queuePosition(first.id)).toBeNull();
    expect(store.queuePosition(second.id)).toBe(1);
    expect(store.queuePosition(third.id)).toBe(2);
    // Waiting jobs have no startup deadline until promoted.
    expect(second.deadlineAt).toBeNull();
    expect(store.expireTimedOut(new Date("2026-01-01T00:05:00Z"))).toHaveLength(0);

    // Cannot promote while first is still active.
    expect(store.promoteNext(t2)).toBeUndefined();

    // Once first finishes, second promotes to active with a fresh deadline.
    store.cancel(first.id);
    const promoted = store.promoteNext(new Date("2026-01-01T00:03:00Z"));
    expect(promoted?.id).toBe(second.id);
    expect(promoted?.deadlineAt).not.toBeNull();
    expect(store.activeJob()?.id).toBe(second.id);
    expect(store.queuedJobs().map((j) => j.id)).toEqual([third.id]);
    expect(store.queuePosition(third.id)).toBe(1);
  });

  it("allows canceling a waiting queued job without disturbing the active job", () => {
    const first = store.create(input);
    const second = store.create({ ...input, issueNumber: 8 });
    const third = store.create({ ...input, issueNumber: 9 });

    store.cancel(second.id);
    expect(store.get(second.id).state).toBe("canceled");
    expect(store.activeJob()?.id).toBe(first.id);
    expect(store.queuedJobs().map((j) => j.id)).toEqual([third.id]);
    expect(store.queuePosition(third.id)).toBe(1);
  });

  it(`caps the waiting queue at ${MAX_QUEUED_JOBS} jobs`, () => {
    store.create(input);
    for (let i = 0; i < MAX_QUEUED_JOBS; i++) {
      store.create({ ...input, issueNumber: 100 + i });
    }
    expect(() => store.create({ ...input, issueNumber: 999 })).toThrow(QueueFullError);
  });

  it("is enforced by the database even if the app check is bypassed", () => {
    const db = openDatabase(":memory:");
    const s = new JobStore(db);
    s.create(input);
    const insert = () =>
      db
        .prepare(
          `INSERT INTO jobs (id, repo_owner, repo_name, issue_number, issue_title, issue_url, state, active, created_at, updated_at, state_entered_at)
           VALUES ('x', 'a', 'b', 1, 't', 'u', 'queued', 1, 'n', 'n', 'n')`,
        )
        .run();
    expect(insert).toThrow(/UNIQUE/);
  });

  it("queues a retried failed job when another job is active", () => {
    const a = store.create(input);
    store.fail(a.id, "boom");
    const b = store.create({ ...input, issueNumber: 9 });
    const retried = store.retry(a.id);
    expect(retried).toMatchObject({ state: "queued", attempt: 2, deadlineAt: null });
    expect(store.activeJob()?.id).toBe(b.id);
    expect(store.queuePosition(a.id)).toBe(1);
  });

  it("promotes and kicks the next queued job after runner cleans up a finished job", async () => {
    const first = store.create(input);
    const second = store.create({ ...input, issueNumber: 8 });
    const destroyed: string[] = [];
    const promoted: string[] = [];
    const deps: RunnerDeps = {
      store,
      getAllowedRepo: vi.fn(),
      getBranchHeadSha: vi.fn(),
      getAllowedIssue: vi.fn(),
      model: vi.fn(),
      createSandbox: vi.fn(),
      openSandbox: vi.fn(),
      destroySandbox: vi.fn(async (name) => {
        destroyed.push(name);
        return true;
      }),
      publish: vi.fn(),
      onPromote: (id) => promoted.push(id),
    };

    // Calling runJob on a still-waiting queued job is a safe no-op.
    const untouched = await runJob(second.id, deps);
    expect(untouched.state).toBe("queued");
    expect(store.activeJob()?.id).toBe(first.id);

    // Canceling the active job and running cleanup promotes and kicks the next queued job.
    store.cancel(first.id);
    await runJob(first.id, deps);
    expect(destroyed).toEqual([first.spriteName]);
    expect(store.activeJob()?.id).toBe(second.id);
    expect(promoted).toEqual([second.id]);
  });

  it("lists jobs created against a specific issue newest first", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const t1 = new Date("2026-01-01T00:01:00Z");
    const t2 = new Date("2026-01-01T00:02:00Z");
    const first = store.create(input, t0);
    store.create({ ...input, issueNumber: 8 }, t1);
    const secondForIssue7 = store.create(input, t2);
    store.create({ ...input, repo: "other", issueNumber: 7 }, t2);

    const forIssue7 = store.listForIssue({ owner: "acme", repo: "web", issueNumber: 7 });
    expect(forIssue7.map((j) => j.id)).toEqual([secondForIssue7.id, first.id]);
  });
});

describe("bounded loops", () => {
  it(`allows at most ${MAX_REPAIR_ATTEMPTS} repair attempts`, () => {
    const job = store.create(input);
    for (const state of happyPath.slice(0, 5)) store.transition(job.id, state); // → testing
    for (let i = 0; i < MAX_REPAIR_ATTEMPTS; i++) {
      store.transition(job.id, "editing");
      store.transition(job.id, "testing");
    }
    expect(store.get(job.id).retryCount).toBe(MAX_REPAIR_ATTEMPTS);
    expect(() => store.transition(job.id, "editing")).toThrow(/Repair limit/);
  });

  it(`allows at most ${MAX_ATTEMPTS} attempts`, () => {
    const job = store.create(input);
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      store.fail(job.id, "boom");
      const retried = store.retry(job.id);
      expect(retried).toMatchObject({ state: "queued", attempt: i + 1, retryCount: 0, error: null, failureReason: null });
    }
    store.fail(job.id, "boom");
    expect(() => store.retry(job.id)).toThrow(/Retry limit/);
  });
});

describe("timeouts", () => {
  it("fails jobs past their state deadline with reason timeout", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const job = store.create(input, t0);
    store.transition(job.id, "provisioning", { now: t0 });
    expect(store.expireTimedOut(new Date(t0.getTime() + 60_000))).toHaveLength(0);
    const expired = store.expireTimedOut(new Date(t0.getTime() + 11 * 60_000));
    expect(expired).toHaveLength(1);
    expect(store.get(job.id)).toMatchObject({ state: "failed", failureReason: "timeout" });
    expect(store.events(job.id).at(-1)?.message).toMatch(/Timed out in provisioning/);
  });
});

describe("evidence", () => {
  it("never records passed without a zero exit code, and redacts output", () => {
    const job = store.create(input);
    for (const state of happyPath.slice(0, 5)) store.transition(job.id, state);
    const updated = store.transition(job.id, "awaiting_publish_approval", {
      patch: {
        testResults: [
          { name: "test", command: ["npm", "test"], status: "passed", exitCode: 1, durationMs: 10, output: "FAIL" },
          { name: "lint", command: ["npm", "run", "lint"], status: "passed", exitCode: 0, durationMs: 5, output: "GITHUB_TOKEN=abcdef123" },
          { name: "build", command: ["npm", "run", "build"], status: "not_run", exitCode: null, durationMs: null, output: "" },
        ],
        diff: "diff --git a/x b/x",
      },
    });
    expect(updated.testResults.map((r) => r.status)).toEqual(["failed", "passed", "not_run"]);
    expect(updated.testResults[1].output).toBe("GITHUB_TOKEN=[REDACTED]");
    expect(updated.diff).toBe("diff --git a/x b/x");
  });
});

describe("durability", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shipfig-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("survives reopening the database (process restart)", () => {
    const path = join(dir, "db.sqlite");
    const db1 = openDatabase(path);
    const s1 = new JobStore(db1);
    const job = s1.create(input);
    s1.transition(job.id, "provisioning", {
      patch: { baseSha: "a".repeat(40), checkpointId: "v2", workspace: { root: "/w", packageManager: "npm", scripts: { test: "vitest" }, installExitCode: 0 } },
    });
    db1.close();

    const s2 = new JobStore(openDatabase(path));
    expect(s2.get(job.id)).toMatchObject({
      state: "provisioning",
      issueNumber: 7,
      baseSha: "a".repeat(40),
      checkpointId: "v2",
      workspace: { scripts: { test: "vitest" } },
    });
    expect(s2.activeJob()?.id).toBe(job.id);
    const queued = s2.create({ ...input, issueNumber: 8 });
    expect(s2.queuePosition(queued.id)).toBe(1);
  });
});

/** A legal transition path from queued to `target`, or null if unreachable that way. */
function pathTo(target: JobState): JobState[] | null {
  if (target === "queued") return [];
  const idx = happyPath.indexOf(target);
  if (idx >= 0) return happyPath.slice(0, idx + 1);
  if (target === "failed") return ["failed"];
  if (target === "canceled") return ["canceled"];
  return null;
}
