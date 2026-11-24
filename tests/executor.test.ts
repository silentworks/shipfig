import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ExecutorSession, executePlan, writeTools } from "@/lib/agent/executor";
import type { Tool } from "@/lib/agent/loop";
import { policyViolations, writePolicy } from "@/lib/agent/policy";
import type { Plan } from "@/lib/agent/planner";
import type { Issue } from "@/lib/github/schemas";
import { openDatabase } from "@/lib/jobs/db";
import { type RunnerDeps, runJob } from "@/lib/jobs/runner";
import { type Job, JobStore, type WorkspaceInfo } from "@/lib/jobs/store";
import { FakeModel, type Step } from "./helpers/fake-model";
import { FakeRepo, ROOT, SHA } from "./helpers/fake-repo";

const FILES = {
  "package.json": '{"scripts":{"test":"vitest run"}}',
  "package-lock.json": "{}",
  "src/sum.ts": "export function sum(a: number, b: number) {\n  return a - b;\n}\n",
  "src/sum.test.ts": "import { sum } from './sum';\n",
};
const passesWhenFixed = { test: (f: Record<string, string>) => (f["src/sum.ts"].includes("a + b") ? { exitCode: 0, stdout: "1 passed" } : { exitCode: 1, stdout: "expected 3, received -1" }) };

const workspace: WorkspaceInfo = { root: ROOT, packageManager: "npm", scripts: { test: "vitest run" }, installExitCode: 0 };
const issue = { number: 3, title: "sum() subtracts", body: "fix it", state: "open", url: "u", author: null, labels: [], comments: 0, createdAt: "", updatedAt: "" } as unknown as Issue;
const plan: Plan = {
  summary: "Use addition",
  files: ["src/sum.ts", "src/sum.test.ts"],
  changes: ["return a + b", "add regression test"],
  checks: ["test"],
  risks: [],
  needsClarification: false,
  clarificationQuestion: null,
};
const planRecord = {
  plan,
  existingFiles: ["src/sum.ts", "src/sum.test.ts"],
  newFiles: [],
  invalidFiles: [],
  runnableChecks: ["test" as const],
  missingChecks: [],
  analysis: { model: "fake-model", turns: 1, toolCalls: 0, inputTokens: 1, outputTokens: 1, filesRead: [], createdAt: "" },
};

const fix: Step = { tools: [{ name: "edit_file", args: { path: "src/sum.ts", oldText: "a - b", newText: "a + b" } }] };
const brokenFix: Step = { tools: [{ name: "edit_file", args: { path: "src/sum.ts", oldText: "a - b", newText: "a * b" } }] };
const addTest: Step = { tools: [{ name: "write_file", args: { path: "src/sum.test.ts", content: "test('sum', () => expect(sum(1, 2)).toBe(3));\n" } }] };
const report = (exitCode: number | null = 0): Step => ({
  text: JSON.stringify({ summary: "Fixed sum", changedFiles: ["src/sum.ts"], addedRegressionTest: true, checksRun: [{ check: "test", exitCode }], concerns: [] }),
});

describe("write policy", () => {
  it("protects credentials, CI, deployment, dependencies and git internals", () => {
    for (const p of [".env", ".github/workflows/ci.yml", "Dockerfile", "docker-compose.yml", "fly.toml", "vercel.json", "package.json", "package-lock.json", "yarn.lock", ".npmrc", "node_modules/x/index.js", ".git/config", "infra/main.tf", "web/Dockerfile.prod"]) {
      expect(writePolicy(p).ok, p).toBe(false);
    }
    for (const p of ["src/sum.ts", "test/sum.test.ts", "docs/usage.md", "README.md", "CONTRIBUTING.md", ".env.example"]) {
      expect(writePolicy(p).ok, p).toBe(true);
    }
    expect(policyViolations(["src/a.ts", "package.json"])).toEqual([{ path: "package.json", reason: expect.stringMatching(/protected/) }]);
  });
});

describe("write tools", () => {
  let repo: FakeRepo;
  let session: ExecutorSession;
  let tools: Map<string, Tool>;
  const call = (name: string, args: unknown) => tools.get(name)!.handler(args as never);

  beforeEach(() => {
    repo = new FakeRepo(FILES, passesWhenFixed);
    session = { written: new Set(), checkRuns: [], refusals: [] };
    tools = new Map(writeTools(repo, ROOT, ["test"], session).map((t) => [t.name, t]));
  });

  it("refuses protected paths and records the refusal", async () => {
    for (const path of ["package.json", ".github/workflows/x.yml", ".env", "../outside.ts", "/etc/passwd"]) {
      await expect(call("write_file", { path, content: "x" }), path).rejects.toThrow();
    }
    expect(session.refusals).toHaveLength(3);
    expect(repo.files.size).toBe(0);
  });

  it("edits with exact single matches only", async () => {
    await expect(call("edit_file", { path: "src/sum.ts", oldText: "a * b", newText: "x" })).rejects.toThrow(/not found/);
    await expect(call("edit_file", { path: "src/sum.ts", oldText: "number", newText: "x" })).rejects.toThrow(/more than once/);
    await call("edit_file", { path: "src/sum.ts", oldText: "a - b", newText: "a + b" });
    expect(repo.current["src/sum.ts"]).toContain("return a + b;");
    expect([...session.written]).toEqual(["src/sum.ts"]);
  });

  it("caps content size and the number of changed files", async () => {
    await expect(call("write_file", { path: "src/big.ts", content: "x".repeat(100_001) })).rejects.toThrow(/too large/);
    for (let i = 0; i < 15; i++) await call("write_file", { path: `src/f${i}.ts`, content: "x" });
    await expect(call("write_file", { path: "src/one-more.ts", content: "x" })).rejects.toThrow(/Change limit/);
  });

  it("runs only approved checks, with real exit codes, and caps runs", async () => {
    expect(await call("run_check", { check: "test" })).toMatch(/npm test → exit 1/);
    await expect(call("run_check", { check: "build" })).rejects.toThrow(/not approved/);
    for (let i = 0; i < 5; i++) await call("run_check", { check: "test" });
    await expect(call("run_check", { check: "test" })).rejects.toThrow(/limit/);
    expect(session.checkRuns.every((r) => r.status === "failed" && r.exitCode === 1)).toBe(true);
  });
});

describe("executePlan", () => {
  it("follows the plan with bounded tools and returns its report", async () => {
    const repo = new FakeRepo(FILES, passesWhenFixed);
    const model = new FakeModel([
      { tools: [{ name: "read_file", args: { path: "src/sum.ts", startLine: null, endLine: null } }] },
      fix,
      addTest,
      { tools: [{ name: "run_check", args: { check: "test" } }] },
      report(0),
    ]);
    const result = await executePlan({ sandbox: repo, workspace, issue, plan: planRecord, model });
    expect(model.requests[0].tools.map((t) => t.name)).toEqual(["list_files", "read_file", "search_code", "write_file", "edit_file", "run_check", "get_diff"]);
    expect(model.requests[0].input[0]).toMatchObject({ type: "message", content: expect.stringContaining("<untrusted source=\"issue body\">") });
    expect(repo.changed()).toEqual(["src/sum.test.ts", "src/sum.ts"]);
    expect(result.session.checkRuns.map((r) => r.status)).toEqual(["passed"]);
    expect(result.report.summary).toBe("Fixed sum");
  });
});

describe("runner: editing, testing and repairs", () => {
  let store: JobStore;
  let repo: FakeRepo;

  function deps(model: FakeModel): RunnerDeps {
    return {
      store,
      getAllowedRepo: vi.fn(async () => ({ owner: "acme", name: "web", fullName: "acme/web", private: false, url: "", cloneUrl: "", defaultBranch: "main", description: null, openIssuesCount: 1, archived: false, canPush: true })),
      getBranchHeadSha: vi.fn(async () => SHA),
      getAllowedIssue: vi.fn(async () => issue),
      model: () => model,
      createSandbox: vi.fn(async () => repo),
      openSandbox: vi.fn(async () => repo),
      destroySandbox: vi.fn(async () => true),
    };
  }

  /** Drive a job to plan approval and approve it. */
  async function approvedJob(model: FakeModel): Promise<{ job: Job; d: RunnerDeps }> {
    const d = deps(model);
    const created = store.create({ owner: "acme", repo: "web", issueNumber: 3, issueTitle: "t", issueUrl: "u" });
    const awaiting = await runJob(created.id, d);
    expect(awaiting.state).toBe("awaiting_plan_approval");
    return { job: store.approvePlan(created.id, awaiting.version, "local operator"), d };
  }

  beforeEach(() => {
    store = new JobStore(openDatabase(":memory:"));
    repo = new FakeRepo(FILES, passesWhenFixed);
  });
  const planStep: Step = { text: JSON.stringify(plan) };

  it("edits, re-runs the checks itself and waits for publish approval", async () => {
    const { job, d } = await approvedJob(new FakeModel([planStep, fix, addTest, report(0)]));
    const done = await runJob(job.id, d);
    expect(done).toMatchObject({ state: "awaiting_publish_approval", retryCount: 0 });
    expect(done.testResults).toMatchObject([{ name: "test", status: "passed", exitCode: 0, command: ["npm", "test"] }]);
    expect(done.diff).toContain("diff --git a/src/sum.ts");
    expect(done.execution).toHaveLength(1);
    expect(done.execution[0]).toMatchObject({ attempt: 0, filesWritten: ["src/sum.ts", "src/sum.test.ts"] });
  });

  it("does not trust the executor's claim: its 'passed' report is ignored when checks fail", async () => {
    // Executor makes a wrong fix and claims exit 0; two repairs keep it wrong.
    const { job, d } = await approvedJob(new FakeModel([planStep, brokenFix, report(0), report(0), report(0)]));
    const done = await runJob(job.id, d);
    expect(done).toMatchObject({ state: "failed", failureReason: "repair_limit", retryCount: 2 });
    expect(done.testResults).toMatchObject([{ status: "failed", exitCode: 1 }]);
    expect(done.error).toMatch(/npm test exited 1 after 2 repair attempts/);
    expect(done.execution.map((a) => a.attempt)).toEqual([0, 1, 2]);
    expect(store.events(job.id).filter((e) => /starting repair attempt/.test(e.message))).toHaveLength(2);
    expect(d.destroySandbox).toHaveBeenCalled();
  });

  it("repairs with the failing output and succeeds within the budget", async () => {
    const model = new FakeModel([planStep, brokenFix, report(1), { tools: [{ name: "edit_file", args: { path: "src/sum.ts", oldText: "a * b", newText: "a + b" } }] }, report(0)]);
    const { job, d } = await approvedJob(model);
    const done = await runJob(job.id, d);
    expect(done).toMatchObject({ state: "awaiting_publish_approval", retryCount: 1 });
    const repairInput = model.requests[3].input[0];
    expect(repairInput).toMatchObject({ type: "message", content: expect.stringContaining("REPAIR ATTEMPT 1") });
    expect(repairInput.type === "message" && repairInput.content).toContain("expected 3, received -1");
  });

  it("fails with policy_violation if a protected file changed anyway", async () => {
    const { job, d } = await approvedJob(new FakeModel([planStep, fix, report(0)]));
    repo.current["package.json"] = '{"scripts":{"test":"true"}}'; // e.g. changed by a check script
    const done = await runJob(job.id, d);
    expect(done).toMatchObject({ state: "failed", failureReason: "policy_violation" });
    expect(done.error).toMatch(/package\.json/);
  });

  it("fails with no_changes when nothing was edited", async () => {
    const { job, d } = await approvedJob(new FakeModel([planStep, report(0)]));
    expect(await runJob(job.id, d)).toMatchObject({ state: "failed", failureReason: "no_changes" });
  });
});
