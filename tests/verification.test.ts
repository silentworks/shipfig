import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Plan } from "@/lib/agent/planner";
import type { Issue } from "@/lib/github/schemas";
import { openDatabase } from "@/lib/jobs/db";
import { type RunnerDeps, runJob } from "@/lib/jobs/runner";
import { type Job, JobStore, type TestResult } from "@/lib/jobs/store";
import {
  captureDiff,
  missingCheckResults,
  secretsInPatch,
  summarizeOutput,
  testWeakeningSigns,
  verificationOutcome,
} from "@/lib/verify/evidence";
import { FakeModel, type Step } from "./helpers/fake-model";
import { FakeRepo, ROOT, SHA } from "./helpers/fake-repo";
import { FakeSandbox } from "./helpers/fake-sandbox";

const result = (over: Partial<TestResult>): TestResult => ({ name: "test", command: ["npm", "test"], status: "passed", exitCode: 0, durationMs: 1, output: "", ...over });

describe("output summaries", () => {
  it.each([
    [" Test Files  1 passed (1)\n      Tests  3 passed (3)\n   Duration 1s", "3 passed (3)"],
    ["Tests:       1 failed, 2 passed, 3 total", "1 failed, 2 passed, 3 total"],
    ["# tests 2\n# pass 1\n# fail 1\n", "pass 1, fail 1"],
    ["ℹ tests 1\nℹ pass 1\nℹ fail 0", "pass 1, fail 0"],
    ["  4 passing (12ms)\n  1 failing", "4 passing (12ms), 1 failing"],
    ["src/a.ts(1,1): error TS2322\nFound 2 errors in 1 file.", "Found 2 errors in 1 file."],
    ["✖ 3 problems (3 errors, 0 warnings)", "✖ 3 problems (3 errors, 0 warnings)"],
    ["\x1b[32mbuilt in 2s\x1b[0m\n", "built in 2s"],
  ])("%j → %s", (output, expected) => {
    expect(summarizeOutput(output)).toBe(expected);
  });
});

describe("verification outcome", () => {
  it("is decided by exit codes, with missing checks never counted as passing", () => {
    expect(verificationOutcome([result({})], [])).toBe("verified");
    expect(verificationOutcome([result({}), ...missingCheckResults(["lint"])], ["lint"])).toBe("unverified");
    expect(verificationOutcome([], [])).toBe("unverified");
    expect(verificationOutcome([result({ status: "failed", exitCode: 1 })], [])).toBe("failed");
    expect(verificationOutcome([result({ status: "timed_out", exitCode: null })], [])).toBe("failed");
    // A "passed" label with a non-zero exit is a failure.
    expect(verificationOutcome([result({ status: "passed", exitCode: 2 })], [])).toBe("failed");
    expect(missingCheckResults(["lint"])[0]).toMatchObject({ status: "not_run", exitCode: null, command: ["npm", "run", "lint"] });
  });
});

describe("diff evidence", () => {
  it("parses file status and line counts, including renames and binary files", async () => {
    const sb = new FakeSandbox("x", (argv) => {
      if (argv[0] === "sha256sum") return { stdout: `${"c".repeat(64)}  /tmp/shipfig-diff.patch\n` };
      if (argv.includes("--numstat")) return { stdout: "3\t1\tsrc/a.ts\0" + "10\t0\tsrc/new file.test.ts\0" + "-\t-\tlogo.png\0" + "1\t1\t\0old.ts\0src/renamed.ts\0" + "0\t5\tsrc/gone.ts\0" };
      if (argv.includes("--name-status")) return { stdout: "M\0src/a.ts\0A\0src/new file.test.ts\0M\0logo.png\0R095\0old.ts\0src/renamed.ts\0D\0src/gone.ts\0" };
      if (argv[1] === "diff" && !argv.some((a) => a.startsWith("--output"))) return { stdout: "diff --git a/src/a.ts b/src/a.ts\n" };
      return undefined;
    });
    const diff = await captureDiff(sb, ROOT);
    expect(diff.hash).toBe("c".repeat(64));
    expect(diff.files).toEqual([
      { path: "src/a.ts", status: "modified", additions: 3, deletions: 1 },
      { path: "src/new file.test.ts", status: "added", additions: 10, deletions: 0 },
      { path: "logo.png", status: "modified", additions: null, deletions: null },
      { path: "src/renamed.ts", status: "renamed", additions: 1, deletions: 1 },
      { path: "src/gone.ts", status: "deleted", additions: 0, deletions: 5 },
    ]);
    expect(diff).toMatchObject({ additions: 14, deletions: 7, truncated: false });
    expect(sb.commands()).toContain("git diff --binary --no-color --no-ext-diff --output=/tmp/shipfig-diff.patch HEAD");
  });

  it("finds secrets the redactor masked in added lines, and signs of test weakening", () => {
    const patch = [
      "+++ b/src/config.ts",
      "-const a = 1;",
      "+const token = '[REDACTED]';",
      "+++ b/src/sum.test.ts",
      "-  expect(sum(1, 2)).toBe(3);",
      "+it.skip('sum', () => {});",
    ].join("\n");
    expect(secretsInPatch(patch)).toEqual(["src/config.ts"]);
    expect(testWeakeningSigns(patch)).toEqual(["src/sum.test.ts: 1 fewer assertion line(s)", "src/sum.test.ts: skipped or focused tests added"]);
    // Rewriting an assertion is not weakening.
    expect(testWeakeningSigns("+++ b/a.test.ts\n-  expect(x).toBe(1);\n+  expect(x).toBe(2);")).toEqual([]);
  });
});

describe("runner: verification evidence", () => {
  const FILES = {
    "package.json": '{"scripts":{"test":"vitest run"}}',
    "package-lock.json": "{}",
    "src/sum.ts": "export const sum = (a: number, b: number) => a - b;\n",
    "src/sum.test.ts": "test('sum', () => expect(sum(1, 1)).toBe(2));\n",
  };
  const fixedTest = { test: (f: Record<string, string>) => (f["src/sum.ts"].includes("a + b") ? { exitCode: 0, stdout: "Tests  2 passed (2)" } : { exitCode: 1, stdout: "Tests  1 failed | 1 passed (2)" }) };
  const issue = { number: 3, title: "sum() subtracts", body: "fix", state: "open", url: "u", author: null, labels: [], comments: 0, createdAt: "", updatedAt: "" } as unknown as Issue;
  const plan = (checks: Plan["checks"]): Step => ({
    text: JSON.stringify({ summary: "Use addition", files: ["src/sum.ts", "src/sum.test.ts"], changes: ["a + b"], checks, risks: [], needsClarification: false, clarificationQuestion: null } satisfies Plan),
  });
  const fix: Step = { tools: [{ name: "edit_file", args: { path: "src/sum.ts", oldText: "a - b", newText: "a + b" } }] };
  const addTest: Step = { tools: [{ name: "write_file", args: { path: "src/sum.test.ts", content: "test('sum', () => expect(sum(1, 2)).toBe(3));\n" } }] };
  const report: Step = { text: JSON.stringify({ summary: "Fixed", changedFiles: ["src/sum.ts"], addedRegressionTest: true, checksRun: [], concerns: [] }) };
  const review = (verdict: "pass" | "fail", concerns: string[] = []): Step => ({ text: JSON.stringify({ verdict, concerns, evidence: ["npm test exit 0"] }) });

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
      publish: vi.fn(async () => {
        throw new Error("publish not expected in this test");
      }),
    };
  }
  async function run(steps: Step[]): Promise<{ done: Job; model: FakeModel }> {
    const model = new FakeModel(steps);
    const d = deps(model);
    const job = store.create({ owner: "acme", repo: "web", issueNumber: 3, issueTitle: "t", issueUrl: "u" });
    const awaiting = await runJob(job.id, d);
    store.approvePlan(job.id, awaiting.version, "local operator");
    return { done: await runJob(job.id, d), model };
  }

  beforeEach(() => {
    store = new JobStore(openDatabase(":memory:"));
    repo = new FakeRepo(FILES, fixedTest);
  });

  it("records baseline, real results, diff evidence and a passing review", async () => {
    const { done, model } = await run([plan(["test"]), fix, addTest, report, review("pass")]);
    expect(done.state).toBe("awaiting_publish_approval");
    expect(done.baselineResults).toMatchObject([{ name: "test", status: "failed", exitCode: 1, summary: "1 failed | 1 passed (2)" }]);
    expect(done.testResults).toMatchObject([{ name: "test", status: "passed", exitCode: 0, summary: "2 passed (2)" }]);
    expect(done.testResults[0].durationMs).toEqual(expect.any(Number));
    expect(done.diffHash).toBe(repo.diffHash());
    expect(done.verification).toMatchObject({
      outcome: "verified",
      regressionTestChanged: true,
      review: { verdict: "pass" },
      reviewError: null,
      diff: { files: [{ path: "src/sum.test.ts", status: "modified" }, { path: "src/sum.ts", status: "modified" }] },
    });
    expect(done.verification!.flags).toEqual(["test was already failing (exit 1) before any change"]);
    // The review saw Shipfig's recorded results, not the executor's claims.
    const reviewInput = model.requests.at(-1)!.input[0];
    expect(reviewInput.type === "message" && reviewInput.content).toContain("npm test: passed (exit 0) — 2 passed (2)");
    expect(model.requests.at(-1)!.tools).toEqual([]);
  });

  it("reports missing checks separately and marks the change unverified", async () => {
    const { done } = await run([plan(["test", "lint"]), fix, addTest, report, review("pass")]);
    expect(done.state).toBe("awaiting_publish_approval");
    expect(done.testResults.map((r) => [r.name, r.status])).toEqual([["test", "passed"], ["lint", "not_run"]]);
    expect(done.verification).toMatchObject({ outcome: "unverified", missingChecks: ["lint"] });
    expect(done.verification!.flags).toContain("Requested checks with no npm script (not run): lint");
  });

  it("flags a change with no regression test", async () => {
    const { done } = await run([plan(["test"]), fix, report, review("pass")]);
    expect(done.verification).toMatchObject({ outcome: "verified", regressionTestChanged: false });
    expect(done.verification!.flags).toContain("No test file was added or changed (no regression test)");
  });

  it("a failing review blocks the change even though checks passed", async () => {
    const { done } = await run([plan(["test"]), fix, addTest, report, review("fail", ["Change is unrelated to the issue"])]);
    expect(done).toMatchObject({ state: "failed", failureReason: "review_failed" });
    expect(done.error).toMatch(/unrelated/);
    expect(done.verification?.outcome).toBe("verified");
  });

  it("an unavailable review is recorded, not treated as a pass", async () => {
    const { done } = await run([plan(["test"]), fix, addTest, report, { text: "not json" }, { text: "still not json" }]);
    expect(done.state).toBe("awaiting_publish_approval");
    expect(done.verification).toMatchObject({ review: null, reviewError: expect.stringMatching(/invalid review/) });
  });

  it("refuses a change that introduces a secret", async () => {
    const leak: Step = { tools: [{ name: "write_file", args: { path: "src/config.ts", content: `export const GITHUB_TOKEN = "ghp_${"a".repeat(36)}";\n` } }] };
    const { done } = await run([plan(["test"]), fix, leak, report, review("pass")]);
    expect(done).toMatchObject({ state: "failed", failureReason: "policy_violation" });
    expect(done.error).toMatch(/secret in: src\/config\.ts/);
    expect(done.diff).not.toContain("ghp_");
  });

  it("keeps failing evidence when repairs run out", async () => {
    const wrong: Step = { tools: [{ name: "edit_file", args: { path: "src/sum.ts", oldText: "a - b", newText: "a * b" } }] };
    const { done } = await run([plan(["test"]), wrong, report, report, report]);
    expect(done).toMatchObject({ state: "failed", failureReason: "repair_limit" });
    expect(done.verification).toMatchObject({ outcome: "failed" });
    expect(done.testResults[0]).toMatchObject({ status: "failed", exitCode: 1, summary: "1 failed | 1 passed (2)" });
    expect(done.diff).toContain("+export const sum = (a: number, b: number) => a * b;");
  });
});
