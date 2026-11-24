import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Plan, PlanRecord } from "@/lib/agent/planner";
import { PublishConflictError, publishBundleToGitHub } from "@/lib/github/publish";
import type { Issue } from "@/lib/github/schemas";
import { openDatabase } from "@/lib/jobs/db";
import { type RunnerDeps, runJob } from "@/lib/jobs/runner";
import { InvalidTransitionError, type Job, JobStore } from "@/lib/jobs/store";
import { BundleError, collectBundle, parseRawDiff } from "@/lib/publish/bundle";
import { codeBlock, inert, pullRequestBody } from "@/lib/publish/pr-body";
import type { PublishBundle } from "@/lib/publish/types";
import { GatewayError } from "@/lib/sprites/gateway";
import { FakeModel, type Step } from "./helpers/fake-model";
import { FakeRepo, ROOT, SHA, gitBlobSha } from "./helpers/fake-repo";

const BASE_TREE = "b".repeat(40);
const draft = () => ({ title: "Fix #3: sum() subtracts", body: "body", commitMessage: "Fix #3" });

/** In-memory GitHub Git database + pulls API, shaped like the gateway client. */
class FakeGitHub {
  blobs = new Map<string, string>();
  trees = new Map<string, unknown>();
  commits = new Map<string, { tree: string; parents: string[] }>([[SHA, { tree: BASE_TREE, parents: [] }]]);
  refs = new Map<string, string>([["main", SHA]]);
  pulls: { number: number; head: string; base: string; title: string; body: string; draft: boolean; state: string }[] = [];
  calls: string[] = [];
  /** Corrupt uploaded blobs (to prove the hash check). */
  corruptBlobs = false;

  private id(kind: string, value: unknown) {
    return createHash("sha1").update(kind + JSON.stringify(value)).digest("hex");
  }

  request = async (path: string, options: { method?: string; body?: Record<string, unknown>; query?: Record<string, unknown> } = {}) => {
    const method = options.method ?? "GET";
    this.calls.push(`${method} ${path}`);
    const fail = (status: number) => {
      throw new GatewayError(`${method} ${path} → ${status}`, status === 404 ? "not_found" : "http", status);
    };
    const route = path.replace(/^\/repos\/acme\/web/, "");
    let m: RegExpExecArray | null;
    if (method === "GET" && (m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(route))) {
      const c = this.commits.get(m[1]) ?? fail(404);
      return { status: 200, data: { sha: m[1], tree: { sha: c!.tree }, parents: c!.parents.map((sha) => ({ sha })) } };
    }
    if (method === "GET" && (m = /^\/git\/ref\/heads\/(.+)$/.exec(route))) {
      const sha = this.refs.get(m[1]) ?? fail(404);
      return { status: 200, data: { object: { sha, type: "commit" } } };
    }
    if (method === "POST" && route === "/git/blobs") {
      let content = Buffer.from(String(options.body!.content), "base64").toString();
      if (this.corruptBlobs) content += "!";
      const sha = gitBlobSha(content);
      this.blobs.set(sha, content);
      return { status: 201, data: { sha } };
    }
    if (method === "POST" && route === "/git/trees") {
      const sha = this.id("tree", options.body);
      this.trees.set(sha, options.body);
      return { status: 201, data: { sha } };
    }
    if (method === "POST" && route === "/git/commits") {
      const sha = this.id("commit", [options.body, this.commits.size]);
      this.commits.set(sha, { tree: String(options.body!.tree), parents: options.body!.parents as string[] });
      return { status: 201, data: { sha } };
    }
    if (method === "POST" && route === "/git/refs") {
      const name = String(options.body!.ref).replace("refs/heads/", "");
      if (this.refs.has(name)) fail(422);
      this.refs.set(name, String(options.body!.sha));
      return { status: 201, data: {} };
    }
    if (method === "GET" && route === "/pulls") {
      const head = String(options.query!.head).replace("acme:", "");
      return { status: 200, data: this.pulls.filter((p) => p.head === head).map((p) => ({ number: p.number, html_url: `https://github.com/acme/web/pull/${p.number}`, state: p.state, draft: p.draft })) };
    }
    if (method === "POST" && route === "/pulls") {
      const b = options.body as { head: string; base: string; title: string; body: string; draft: boolean };
      if (this.pulls.some((p) => p.head === b.head && p.state === "open")) fail(422);
      const pull = { number: this.pulls.length + 10, state: "open", ...b };
      this.pulls.push(pull);
      return { status: 201, data: { number: pull.number, html_url: `https://github.com/acme/web/pull/${pull.number}`, state: "open", draft: b.draft } };
    }
    throw new Error(`FakeGitHub: unhandled ${method} ${path}`);
  };

  /** Tree entries of the branch's commit. */
  branchTree(branch: string) {
    const commit = this.commits.get(this.refs.get(branch)!)!;
    return this.trees.get(commit.tree) as { base_tree: string; tree: { path: string; mode: string; sha: string | null }[] };
  }
}

const bundle = (files: PublishBundle["files"]): PublishBundle => ({
  diffHash: "d".repeat(64),
  baseSha: SHA,
  baseBranch: "main",
  branchName: "shipfig/issue-3-abc123",
  files,
  createdAt: "2026-11-24T00:00:00.000Z",
});
const upsert = (path: string, content: string, mode: "100644" | "100755" = "100644") => ({
  action: "upsert" as const,
  path,
  mode,
  contentBase64: Buffer.from(content).toString("base64"),
  blobSha: gitBlobSha(content),
});

describe("publishBundleToGitHub", () => {
  let gh: FakeGitHub;
  beforeEach(() => {
    gh = new FakeGitHub();
  });
  const publish = (b: PublishBundle) => publishBundleToGitHub({ owner: "acme", repo: "web" }, b, draft, { request: gh.request as never });

  it("creates blobs, a tree on the pinned base, a commit, the branch and a draft PR", async () => {
    const b = bundle([upsert("src/sum.ts", "a + b\n"), upsert("bin/run", "#!/bin/sh\n", "100755"), { action: "delete", path: "old.ts" }]);
    const result = await publish(b);

    expect(result).toMatchObject({ branch: "shipfig/issue-3-abc123", prNumber: 10, draft: true, reused: { commit: false, pullRequest: false }, baseMoved: false });
    expect(gh.branchTree("shipfig/issue-3-abc123")).toEqual({
      base_tree: BASE_TREE,
      tree: [
        { path: "src/sum.ts", mode: "100644", type: "blob", sha: gitBlobSha("a + b\n") },
        { path: "bin/run", mode: "100755", type: "blob", sha: gitBlobSha("#!/bin/sh\n") },
        { path: "old.ts", mode: "100644", type: "blob", sha: null },
      ],
    });
    expect(gh.commits.get(result.commitSha)!.parents).toEqual([SHA]);
    expect(gh.pulls).toEqual([expect.objectContaining({ head: "shipfig/issue-3-abc123", base: "main", draft: true, title: "Fix #3: sum() subtracts" })]);
    // Never merges, deletes or force-updates anything.
    expect(gh.calls.filter((c) => /merge|DELETE|PATCH/.test(c))).toEqual([]);
  });

  it("is idempotent: a retry reuses the branch and the PR instead of duplicating them", async () => {
    const b = bundle([upsert("src/sum.ts", "a + b\n")]);
    const first = await publish(b);
    const second = await publish(b);
    expect(second).toMatchObject({ commitSha: first.commitSha, prNumber: first.prNumber, reused: { commit: true, pullRequest: true } });
    expect(gh.pulls).toHaveLength(1);
    expect(gh.calls.filter((c) => c === "POST /repos/acme/web/git/refs")).toHaveLength(1);
  });

  it("resumes after a lost PR response by finding the PR, and after a lost ref response by checking the branch", async () => {
    const b = bundle([upsert("src/sum.ts", "a + b\n")]);
    // A previous attempt created the branch with this exact change but died before the PR.
    await publish(b);
    gh.pulls = [];
    const again = await publish(b);
    expect(again.reused).toEqual({ commit: true, pullRequest: false });
    expect(gh.pulls).toHaveLength(1);
  });

  it("refuses to overwrite a job branch that holds different content", async () => {
    await publish(bundle([upsert("src/sum.ts", "a + b\n")]));
    await expect(publish(bundle([upsert("src/sum.ts", "something else\n")]))).rejects.toBeInstanceOf(PublishConflictError);
    expect(gh.pulls).toHaveLength(1);
  });

  it("refuses content that does not hash to what the sprite computed", async () => {
    gh.corruptBlobs = true;
    await expect(publish(bundle([upsert("src/sum.ts", "a + b\n")]))).rejects.toThrow(/changed in transit/);
    expect(gh.refs.has("shipfig/issue-3-abc123")).toBe(false);
  });

  it("only writes shipfig/* branches, and notes when the base moved", async () => {
    await expect(publish({ ...bundle([upsert("a.ts", "x")]), branchName: "main" })).rejects.toThrow(/only writes shipfig/);
    gh.refs.set("main", "e".repeat(40));
    expect((await publish(bundle([upsert("a.ts", "x")]))).baseMoved).toBe(true);
  });
});

describe("collectBundle", () => {
  const FILES = { "src/sum.ts": "a - b\n", "src/old.ts": "old\n", "package.json": "{}" };
  const meta = (repo: FakeRepo) => ({ diffHash: repo.diffHash(), baseSha: SHA, baseBranch: "main", branchName: "shipfig/issue-3-abc123" });

  it("takes the exact approved change: contents, modes, deletions and git blob ids", async () => {
    const repo = new FakeRepo(FILES);
    repo.current["src/sum.ts"] = "a + b\n";
    repo.current["src/sum.test.ts"] = "test\n";
    repo.modes["src/sum.test.ts"] = "100755";
    delete repo.current["src/old.ts"];
    const b = await collectBundle(repo, ROOT, meta(repo));
    expect(b.files).toEqual([
      { action: "delete", path: "src/old.ts" },
      upsert("src/sum.test.ts", "test\n", "100755"),
      upsert("src/sum.ts", "a + b\n"),
    ]);
  });

  it("refuses when the workspace no longer matches the approved diff", async () => {
    const repo = new FakeRepo(FILES);
    repo.current["src/sum.ts"] = "a + b\n";
    const approved = meta(repo);
    repo.current["src/sum.ts"] = "a * b\n";
    await expect(collectBundle(repo, ROOT, approved)).rejects.toThrow(/no longer matches the approved diff/);
  });

  it("refuses protected files, secrets, symlinks and oversized files", async () => {
    for (const [path, content, mode, pattern] of [
      ["package.json", '{"scripts":{}}', "100644", /Protected/],
      [".env", "A=1", "100644", /Protected|secret/],
      ["src/link", "x", "120000", /mode 120000/],
      ["src/big.ts", "x".repeat(1_000_001), "100644", /limit/],
    ] as const) {
      const repo = new FakeRepo(FILES);
      repo.current[path] = content;
      repo.modes[path] = mode;
      await expect(collectBundle(repo, ROOT, meta(repo)), path).rejects.toThrow(pattern);
    }
  });

  it("parses git diff --raw -z", () => {
    expect(parseRawDiff(":100644 100755 aaaaaaa bbbbbbb M\0bin/run\0:000000 100644 0000000 0000000 A\0a b.ts\0")).toEqual([
      { newMode: "100755", status: "M", path: "bin/run" },
      { newMode: "100644", status: "A", path: "a b.ts" },
    ]);
    expect(() => parseRawDiff("garbage\0x\0")).toThrow(BundleError);
  });
});

describe("PR text", () => {
  it("neutralises mentions, HTML and cross-repo references in untrusted text", () => {
    expect(inert("ping @octocat <img src=x> see other/repo#12 & #3")).toBe("ping @​octocat &lt;img src=x&gt; see other/repo​#12 &amp; #3");
  });

  it("fences output so it cannot break out of its code block", () => {
    const block = codeBlock("```\n## injected\n```");
    expect(block.startsWith("````text\n")).toBe(true);
    expect(block.endsWith("\n````")).toBe(true);
  });
});

describe("runner: publishing", () => {
  const FILES = {
    "package.json": '{"scripts":{"test":"node --test","lint":"eslint"}}',
    "package-lock.json": "{}",
    "src/sum.ts": "export const sum = (a: number, b: number) => a - b;\n",
    "src/sum.test.ts": "test('sum', () => expect(sum(1, 1)).toBe(2));\n",
  };
  const fixedTest = { test: (f: Record<string, string>) => (f["src/sum.ts"].includes("a + b") ? { exitCode: 0, stdout: "ℹ pass 2\nℹ fail 0" } : { exitCode: 1, stdout: "ℹ pass 1\nℹ fail 1" }) };
  const issue = { number: 3, title: "sum() subtracts @maintainer", body: "fix", state: "open", url: "https://github.com/acme/web/issues/3", author: null, labels: [], comments: 0, createdAt: "", updatedAt: "" } as unknown as Issue;
  const plan = (checks: Plan["checks"]): Step => ({
    text: JSON.stringify({ summary: "Use addition", files: ["src/sum.ts", "src/sum.test.ts"], changes: ["a + b"], checks, risks: ["None really"], needsClarification: false, clarificationQuestion: null } satisfies Plan),
  });
  const steps: Step[] = [
    { tools: [{ name: "edit_file", args: { path: "src/sum.ts", oldText: "a - b", newText: "a + b" } }] },
    { tools: [{ name: "write_file", args: { path: "src/sum.test.ts", content: "test('sum', () => expect(sum(1, 2)).toBe(3));\n" } }] },
    { text: JSON.stringify({ summary: "Fixed", changedFiles: ["src/sum.ts"], addedRegressionTest: true, checksRun: [], concerns: [] }) },
    { text: JSON.stringify({ verdict: "pass", concerns: [], evidence: ["npm test exit 0"] }) },
  ];

  let store: JobStore;
  let repo: FakeRepo | undefined;
  let gh: FakeGitHub;
  let failNextPublish: boolean;
  let d: RunnerDeps;

  beforeEach(() => {
    store = new JobStore(openDatabase(":memory:"));
    repo = new FakeRepo(FILES, fixedTest);
    gh = new FakeGitHub();
    failNextPublish = false;
  });

  async function toPublishApproval(checks: Plan["checks"] = ["test"]): Promise<Job> {
    const model = new FakeModel([plan(checks), ...steps]);
    d = {
      store,
      getAllowedRepo: vi.fn(async () => ({ owner: "acme", name: "web", fullName: "acme/web", private: false, url: "", cloneUrl: "", defaultBranch: "main", description: null, openIssuesCount: 1, archived: false, canPush: true })),
      getBranchHeadSha: vi.fn(async () => SHA),
      getAllowedIssue: vi.fn(async () => issue),
      model: () => model,
      createSandbox: vi.fn(async () => repo!),
      openSandbox: vi.fn(async () => repo),
      destroySandbox: vi.fn(async () => true),
      publish: vi.fn(async (ref, b, draftFor, opts) => {
        if (failNextPublish) {
          failNextPublish = false;
          throw new GatewayError("Gateway sprite exec failed: Command timed out", "transport");
        }
        return publishBundleToGitHub(ref, b, draftFor, { ...opts, request: gh.request as never });
      }),
    };
    const job = store.create({ owner: "acme", repo: "web", issueNumber: 3, issueTitle: issue.title, issueUrl: issue.url });
    const awaiting = await runJob(job.id, d);
    store.approvePlan(job.id, awaiting.version, "local operator");
    return runJob(job.id, d);
  }

  it("publishes nothing until the exact diff is approved, then opens one draft PR", async () => {
    const ready = await toPublishApproval();
    expect(ready.state).toBe("awaiting_publish_approval");
    expect(d.publish).not.toHaveBeenCalled();
    expect(gh.calls).toEqual([]);

    expect(() => store.approvePublish(ready.id, { expectedVersion: ready.version, diffHash: "0".repeat(64), approvedBy: "local operator" })).toThrow(InvalidTransitionError);
    store.approvePublish(ready.id, { expectedVersion: ready.version, diffHash: ready.diffHash!, approvedBy: "local operator" });
    const done = await runJob(ready.id, d);

    expect(done).toMatchObject({ state: "completed", prUrl: "https://github.com/acme/web/pull/10", publishApprovedHash: ready.diffHash, hasPublishBundle: true });
    expect(done.publishResult).toMatchObject({ prNumber: 10, draft: true, branch: done.branchName });
    expect(gh.branchTree(done.branchName!).tree.map((e) => e.path)).toEqual(["src/sum.test.ts", "src/sum.ts"]);

    const body = gh.pulls[0].body;
    expect(body).toContain("Fixes #3: [sum() subtracts @​maintainer](https://github.com/acme/web/issues/3)");
    expect(body).toContain("| `npm test` | passed | 0 |");
    expect(body).toContain("pass 2, fail 0");
    expect(body).toContain("`src/sum.ts` (modified");
    expect(body).toContain("- None really");
    expect(body).toContain(`diff sha256 \`${ready.diffHash}\``);
    expect(d.destroySandbox).toHaveBeenCalled();
  });

  it("rejecting publish cancels without touching GitHub", async () => {
    const ready = await toPublishApproval();
    const canceled = store.rejectPublish(ready.id, ready.version);
    expect(canceled).toMatchObject({ state: "canceled", cancelReason: "publish_rejected" });
    await runJob(ready.id, d);
    expect(gh.calls).toEqual([]);
  });

  it("publishes the change frozen at verification, without needing the sprite", async () => {
    const ready = await toPublishApproval();
    expect(ready.hasPublishBundle).toBe(true);
    expect(store.publishBundle(ready.id)!.diffHash).toBe(ready.diffHash);
    store.approvePublish(ready.id, { expectedVersion: ready.version, diffHash: ready.diffHash!, approvedBy: "local operator" });

    // The sprite went cold/away and its workspace changed: neither matters now.
    repo!.current["src/sum.ts"] = "tampered\n";
    repo = undefined;
    const done = await runJob(ready.id, d);
    expect(done.state).toBe("completed");
    const tree = gh.branchTree(done.branchName!).tree;
    expect(gh.blobs.get(tree.find((e) => e.path === "src/sum.ts")!.sha!)).toBe("export const sum = (a: number, b: number) => a + b;\n");
  });

  it("a change that cannot be published fails at verification, before anyone is asked to approve it", async () => {
    repo!.modes["src/sum.ts"] = "120000";
    const failed = await toPublishApproval();
    expect(failed).toMatchObject({ state: "failed", failureReason: "policy_violation", hasPublishBundle: false });
    expect(failed.error).toMatch(/cannot be published: .*mode 120000/);
    expect(gh.calls).toEqual([]);
  });

  it("a failed publish is recoverable: retry resumes from the saved change without the sprite, with no duplicates", async () => {
    const ready = await toPublishApproval();
    store.approvePublish(ready.id, { expectedVersion: ready.version, diffHash: ready.diffHash!, approvedBy: "local operator" });
    failNextPublish = true;
    const failed = await runJob(ready.id, d);
    expect(failed).toMatchObject({ state: "failed", failureReason: "publish_error", hasPublishBundle: true });
    expect(failed.error).toMatch(/Retry to resume/);

    // The sprite is gone after the failure; the saved bundle is enough.
    repo = undefined;
    const resumed = store.retry(failed.id);
    expect(resumed.state).toBe("publishing");
    const done = await runJob(failed.id, d);
    expect(done).toMatchObject({ state: "completed", prUrl: "https://github.com/acme/web/pull/10" });

    // A second publish of the same bundle (e.g. a lost response) reuses everything.
    await publishBundleToGitHub({ owner: "acme", repo: "web" }, store.publishBundle(done.id)!, draft, { request: gh.request as never });
    expect(gh.pulls).toHaveLength(1);
  });

  it("requires an explicit acknowledgement to publish an unverified change", async () => {
    const ready = await toPublishApproval(["test", "lint", "build"]);
    expect(ready.verification?.outcome).toBe("unverified");
    expect(() => store.approvePublish(ready.id, { expectedVersion: ready.version, diffHash: ready.diffHash!, approvedBy: "local operator" })).toThrow(/acknowledge/);
    store.approvePublish(ready.id, { expectedVersion: ready.version, diffHash: ready.diffHash!, approvedBy: "local operator", acknowledgeUnverified: true });
    const done = await runJob(ready.id, d);
    expect(done.state).toBe("completed");
    expect(gh.pulls[0].body).toContain("Missing checks (requested, but the repository has no script for them): `build`");
  });

  it("builds a PR body from evidence even without a review", () => {
    const job = {
      id: "abc123", issueNumber: 3, issueTitle: "t", issueUrl: "https://github.com/acme/web/issues/3", baseBranch: "main", baseSha: SHA, diffHash: "d".repeat(64),
      testResults: [], baselineResults: [], verification: null, publishApprovedAt: null, publishApprovedBy: null, planApprovedAt: null,
    } as unknown as Job;
    const record = { plan: { summary: "s", risks: [] } } as unknown as PlanRecord;
    const body = pullRequestBody(job, record, { baseMoved: true });
    expect(body).toContain("`main` has moved since this change was prepared");
  });
});
