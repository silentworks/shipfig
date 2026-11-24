import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Repo } from "@/lib/github/schemas";
import { openDatabase } from "@/lib/jobs/db";
import { type RunnerDeps, runJob } from "@/lib/jobs/runner";
import { JobStore } from "@/lib/jobs/store";
import { SetupError, WORKSPACE_ROOT, parseScripts, provisionWorkspace } from "@/lib/workspace/provision";
import { FakeSandbox, type Handler } from "./helpers/fake-sandbox";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const repo: Repo = {
  owner: "acme",
  name: "web",
  fullName: "acme/web",
  private: false,
  url: "https://github.com/acme/web",
  cloneUrl: "https://github.com/acme/web.git",
  defaultBranch: "main",
  description: null,
  openIssuesCount: 1,
  archived: false,
  canPush: true,
};

const PKG = JSON.stringify({ scripts: { test: "vitest run", lint: "eslint .", "bad name;rm": "x", build: 5 } });

function npmRepo(overrides: Record<string, Partial<ReturnType<Handler> & object>> = {}): Handler {
  return (argv) => {
    const cmd = argv.join(" ");
    for (const [prefix, result] of Object.entries(overrides)) if (cmd.startsWith(prefix)) return result;
    if (cmd === "git rev-parse HEAD") return { stdout: `${SHA}\n` };
    if (cmd.startsWith("git ls-files")) return { stdout: "package.json\npackage-lock.json\n" };
    if (cmd === "cat package.json") return { stdout: PKG };
    return undefined;
  };
}

function provisionDeps(sandbox: FakeSandbox) {
  return {
    getAllowedRepo: vi.fn(async () => repo),
    getBranchHeadSha: vi.fn(async () => SHA),
    createSandbox: vi.fn(async () => sandbox),
    log: vi.fn(),
  };
}

const input = { jobId: "abc123abc123", owner: "acme", repo: "web", issueNumber: 7, spriteName: "shipfig-job-abc123abc123" };

describe("provisionWorkspace", () => {
  it("checks out the pinned SHA on a job branch, installs without scripts, then checkpoints", async () => {
    const sandbox = new FakeSandbox("shipfig-job-abc123abc123", npmRepo());
    const deps = provisionDeps(sandbox);
    const result = await provisionWorkspace(input, deps);

    expect(deps.getBranchHeadSha).toHaveBeenCalledWith({ owner: "acme", repo: "web" }, "main");
    expect(sandbox.commands()).toEqual([
      `mkdir -p ${WORKSPACE_ROOT}`,
      `git init --quiet --initial-branch shipfig-base ${WORKSPACE_ROOT}`,
      "git config core.hooksPath /dev/null",
      "git remote add origin https://github.com/acme/web.git",
      `git fetch --quiet --depth=1 --no-tags origin ${SHA}`,
      "git checkout --quiet -b shipfig/issue-7-abc123abc123 FETCH_HEAD",
      "git rev-parse HEAD",
      "git ls-files -- package.json package-lock.json npm-shrinkwrap.json yarn.lock pnpm-lock.yaml bun.lockb bun.lock",
      "cat package.json",
      "npm ci --ignore-scripts --no-audit --no-fund",
    ]);
    // Never a shell: every command is a plain argv.
    expect(sandbox.calls.every((c) => c.argv[0] !== "sh" && c.argv[0] !== "bash")).toBe(true);
    expect(sandbox.checkpoints).toHaveLength(1);
    expect(result).toMatchObject({
      baseBranch: "main",
      baseSha: SHA,
      branchName: "shipfig/issue-7-abc123abc123",
      checkpointId: "v2",
      workspace: { root: WORKSPACE_ROOT, packageManager: "npm", scripts: { test: "vitest run", lint: "eslint ." }, installExitCode: 0 },
    });
  });

  it("refuses before creating a sprite when the repo is not allowed", async () => {
    const sandbox = new FakeSandbox("x");
    const deps = provisionDeps(sandbox);
    deps.getAllowedRepo.mockRejectedValueOnce(new Error("not in SHIPFIG_ALLOWED_REPOS"));
    await expect(provisionWorkspace(input, deps)).rejects.toMatchObject({ name: "SetupError", step: "authorize" });
    expect(deps.createSandbox).not.toHaveBeenCalled();
  });

  it("surfaces an actionable error when the install fails", async () => {
    const sandbox = new FakeSandbox("x", npmRepo({ "npm ci": { exitCode: 1, stderr: "npm ERR! lockfile out of sync" } }));
    const error = await provisionWorkspace(input, provisionDeps(sandbox)).catch((e) => e);
    expect(error).toBeInstanceOf(SetupError);
    expect(error).toMatchObject({ step: "install" });
    expect(error.message).toMatch(/exit 1.*package-lock/);
    expect(sandbox.checkpoints).toHaveLength(0);
  });

  it("detects a checkout that does not match the pinned SHA", async () => {
    const sandbox = new FakeSandbox("x", npmRepo({ "git rev-parse": { stdout: "f".repeat(40) } }));
    await expect(provisionWorkspace(input, provisionDeps(sandbox))).rejects.toMatchObject({ step: "clone" });
  });

  it("reports clone timeouts", async () => {
    const sandbox = new FakeSandbox("x", npmRepo({ "git fetch": { timedOut: true } }));
    await expect(provisionWorkspace(input, provisionDeps(sandbox))).rejects.toThrow(/timed out/);
  });

  it("refuses non-npm projects with a clear hint", async () => {
    const sandbox = new FakeSandbox("x", npmRepo({ "git ls-files": { stdout: "package.json\nyarn.lock\n" } }));
    await expect(provisionWorkspace(input, provisionDeps(sandbox))).rejects.toThrow(/yarn\.lock.*Only npm/);
  });

  it("skips install for repos without package.json", async () => {
    const sandbox = new FakeSandbox("x", npmRepo({ "git ls-files": { stdout: "" } }));
    const result = await provisionWorkspace(input, provisionDeps(sandbox));
    expect(result.workspace).toMatchObject({ packageManager: "none", installExitCode: null });
    expect(sandbox.commands().some((c) => c.startsWith("npm"))).toBe(false);
  });

  it("parses scripts defensively", () => {
    expect(parseScripts(PKG)).toEqual({ test: "vitest run", lint: "eslint ." });
    expect(() => parseScripts("{nope")).toThrow(SetupError);
  });
});

describe("runner: provisioning stage", () => {
  let store: JobStore;
  let sandbox: FakeSandbox;
  let deps: RunnerDeps;

  beforeEach(() => {
    store = new JobStore(openDatabase(":memory:"));
    sandbox = new FakeSandbox("shipfig-job-x", npmRepo());
    deps = {
      store,
      getAllowedRepo: vi.fn(async () => repo),
      getBranchHeadSha: vi.fn(async () => SHA),
      createSandbox: vi.fn(async () => sandbox),
      openSandbox: vi.fn(async () => sandbox),
      destroySandbox: vi.fn(async () => true),
    };
  });

  const create = () => store.create({ owner: "acme", repo: "web", issueNumber: 7, issueTitle: "t", issueUrl: "https://github.com/acme/web/issues/7" });

  it("provisions and records workspace provenance on the job", async () => {
    const job = create();
    const done = await runJob(job.id, deps);
    expect(done).toMatchObject({
      state: "planning",
      baseSha: SHA,
      baseBranch: "main",
      branchName: `shipfig/issue-7-${job.id}`,
      checkpointId: "v2",
      spriteId: "spr_fake",
    });
    expect(deps.createSandbox).toHaveBeenCalledWith(`shipfig-job-${job.id}`);
    const log = store.events(job.id).map((e) => e.message);
    expect(log).toContain("queued → provisioning");
    expect(log.some((m) => /^\$ npm ci .* → exit 0/.test(m))).toBe(true);
  });

  it("fails with setup_error, keeps diagnostics and deletes the sprite", async () => {
    sandbox = new FakeSandbox("x", npmRepo({ "git fetch": { exitCode: 128, stderr: "fatal: couldn't find remote ref" } }));
    const job = create();
    const done = await runJob(job.id, deps);
    expect(done).toMatchObject({ state: "failed", failureReason: "setup_error" });
    expect(done.error).toMatch(/Setup failed at clone/);
    expect(store.events(job.id).some((e) => e.kind === "command" && /exit 128/.test(e.message))).toBe(true);
    expect(deps.destroySandbox).toHaveBeenCalledWith(`shipfig-job-${job.id}`);
  });

  it("stops and cleans up when the job is canceled mid-provisioning", async () => {
    const job = create();
    deps.createSandbox = vi.fn(async () => {
      store.cancel(job.id);
      return sandbox;
    });
    const done = await runJob(job.id, deps);
    expect(done.state).toBe("canceled");
    expect(deps.destroySandbox).toHaveBeenCalled();
  });
});
