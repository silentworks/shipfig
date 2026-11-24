import type { Repo } from "@/lib/github/schemas";
import type { WorkspaceInfo } from "@/lib/jobs/store";
import type { CommandResult, Sandbox } from "@/lib/sprites/sandbox";
import { type RepoRef, branchNameSchema, repoRefSchema } from "@/lib/validation";

/**
 * SIL-530: provision a job's isolated workspace.
 *
 *   1. Re-check the repo is allowed and eligible; pin the base branch head SHA.
 *   2. Create a fresh, locked-down sprite (network allowlist, memory limit,
 *      no privilege escalation).
 *   3. Fetch exactly the pinned commit anonymously over HTTPS and create the
 *      job's feature branch from it. Git hooks are disabled.
 *   4. Install dependencies with npm, lifecycle scripts disabled.
 *   5. Checkpoint the sprite before any edit.
 *
 * Every command is an argv array built from validated values; no issue or
 * repository text is ever interpolated into a shell.
 */

export const WORKSPACE_ROOT = "/home/sprite/shipfig/repo";

const CLONE_TIMEOUT_MS = 3 * 60_000;
const INSTALL_TIMEOUT_MS = 6 * 60_000;
const MAX_SCRIPT_CHARS = 500;

export type SetupStep = "authorize" | "resolve_base" | "create_sprite" | "clone" | "inspect" | "install" | "checkpoint";

/** A setup failure with the step it happened in and what to do about it. */
export class SetupError extends Error {
  constructor(
    public readonly step: SetupStep,
    message: string,
    public readonly hint: string,
    public readonly result?: CommandResult,
  ) {
    super(`${message} — ${hint}`);
    this.name = "SetupError";
  }
}

export interface ProvisionDeps {
  getAllowedRepo(ref: RepoRef): Promise<Repo>;
  getBranchHeadSha(ref: RepoRef, branch: string): Promise<string>;
  createSandbox(name: string): Promise<Sandbox>;
  /** Record a progress or command event on the job. */
  log(kind: "info" | "command", message: string, data?: unknown): void;
}

export interface ProvisionInput {
  jobId: string;
  owner: string;
  repo: string;
  issueNumber: number;
  spriteName: string;
}

export interface ProvisionResult {
  sandbox: Sandbox;
  spriteId: string | null;
  baseBranch: string;
  baseSha: string;
  branchName: string;
  checkpointId: string;
  workspace: WorkspaceInfo;
}

export function jobBranchName(issueNumber: number, jobId: string): string {
  return branchNameSchema.parse(`shipfig/issue-${issueNumber}-${jobId}`);
}

export function cloneUrl(ref: RepoRef): string {
  const { owner, repo } = repoRefSchema.parse(ref);
  return `https://github.com/${owner}/${repo}.git`;
}

const OTHER_LOCKFILES = ["yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock"];

/** Parse package.json scripts defensively (repo content is untrusted). */
export function parseScripts(packageJson: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    throw new SetupError("inspect", "package.json is not valid JSON", "Fix package.json in the repository, then retry");
  }
  const scripts = (parsed as { scripts?: unknown })?.scripts;
  const out: Record<string, string> = {};
  if (scripts && typeof scripts === "object") {
    for (const [name, cmd] of Object.entries(scripts as Record<string, unknown>)) {
      if (typeof cmd === "string" && /^[A-Za-z0-9:._-]{1,64}$/.test(name)) out[name] = cmd.slice(0, MAX_SCRIPT_CHARS);
    }
  }
  return out;
}

export async function provisionWorkspace(input: ProvisionInput, deps: ProvisionDeps): Promise<ProvisionResult> {
  const ref = repoRefSchema.parse({ owner: input.owner, repo: input.repo });
  const branchName = jobBranchName(input.issueNumber, input.jobId);

  // 1. Authorization and base commit.
  let repo: Repo;
  try {
    repo = await deps.getAllowedRepo(ref);
  } catch (error) {
    throw new SetupError("authorize", `Repository ${ref.owner}/${ref.repo} is not available: ${(error as Error).message}`, "Check SHIPFIG_ALLOWED_REPOS and that the repo is public and not archived");
  }
  const baseBranch = branchNameSchema.parse(repo.defaultBranch);
  let baseSha: string;
  try {
    baseSha = await deps.getBranchHeadSha(ref, baseBranch);
  } catch (error) {
    throw new SetupError("resolve_base", `Could not resolve ${baseBranch}: ${(error as Error).message}`, "Make sure the default branch has at least one commit");
  }
  deps.log("info", `Pinned ${ref.owner}/${ref.repo}@${baseBranch} to ${baseSha.slice(0, 12)}`);

  // 2. Sprite.
  let sandbox: Sandbox;
  try {
    sandbox = await deps.createSandbox(input.spriteName);
  } catch (error) {
    throw new SetupError("create_sprite", `Could not create sprite ${input.spriteName}: ${(error as Error).message}`, "Check SPRITES_TOKEN, your Sprites quota and status.sprites.dev, then retry");
  }
  deps.log("info", `Sprite ${sandbox.name} ready (network allowlist, memory limit, no privilege escalation)`);

  const run = async (step: SetupStep, argv: string[], opts: { cwd?: string; timeoutMs?: number } = {}, hint = "See the command output in the job log") => {
    const result = await sandbox.run(argv, { cwd: opts.cwd ?? WORKSPACE_ROOT, timeoutMs: opts.timeoutMs });
    const retried = result.retries ? `, retried ${result.retries}× after a Sprites container error` : "";
    deps.log("command", `$ ${argv.join(" ")} → ${result.timedOut ? "timed out" : `exit ${result.exitCode}`} (${(result.durationMs / 1000).toFixed(1)}s${retried})`, {
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stderr: result.exitCode === 0 ? undefined : result.stderr.slice(-2000),
    });
    if (result.exitCode !== 0) {
      throw new SetupError(step, `\`${argv.slice(0, 3).join(" ")}\` ${result.timedOut ? "timed out" : `failed with exit ${result.exitCode}`}`, hint, result);
    }
    return result;
  };

  // 3. Pinned checkout. Fetch-by-SHA works for public GitHub repos.
  const cloneHint = "Check the repository is public and reachable from github.com";
  await run("clone", ["mkdir", "-p", WORKSPACE_ROOT], { cwd: "/" });
  await run("clone", ["git", "init", "--quiet", "--initial-branch", "shipfig-base", WORKSPACE_ROOT], { cwd: "/" });
  await run("clone", ["git", "config", "core.hooksPath", "/dev/null"]);
  await run("clone", ["git", "remote", "add", "origin", cloneUrl(ref)]);
  await run("clone", ["git", "fetch", "--quiet", "--depth=1", "--no-tags", "origin", baseSha], { timeoutMs: CLONE_TIMEOUT_MS }, cloneHint);
  await run("clone", ["git", "checkout", "--quiet", "-b", branchName, "FETCH_HEAD"]);
  const head = (await run("clone", ["git", "rev-parse", "HEAD"])).stdout.trim();
  if (head !== baseSha) throw new SetupError("clone", `Checked out ${head}, expected ${baseSha}`, "Retry the job");

  // 4. Dependencies.
  const tracked = new Set(
    (await run("inspect", ["git", "ls-files", "--", "package.json", "package-lock.json", "npm-shrinkwrap.json", ...OTHER_LOCKFILES])).stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  let workspace: WorkspaceInfo = { root: WORKSPACE_ROOT, packageManager: "none", scripts: {}, installExitCode: null };
  if (tracked.has("package.json")) {
    const other = OTHER_LOCKFILES.find((f) => tracked.has(f));
    if (other && !tracked.has("package-lock.json")) {
      throw new SetupError("inspect", `Repository uses ${other}`, "Only npm projects are supported for now; add a package-lock.json or use an npm-based demo repo");
    }
    const pkg = await sandbox.run(["cat", "package.json"], { cwd: WORKSPACE_ROOT, maxOutputChars: 200_000 });
    if (pkg.exitCode !== 0) throw new SetupError("inspect", "Could not read package.json", "Retry the job", pkg);
    const scripts = parseScripts(pkg.stdout);
    // Lifecycle scripts are disabled: repository code must not run during setup.
    const install = tracked.has("package-lock.json") || tracked.has("npm-shrinkwrap.json")
      ? ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]
      : ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"];
    const result = await run("install", install, { timeoutMs: INSTALL_TIMEOUT_MS }, "Dependency install failed; check package.json/package-lock.json are in sync and only use the public npm registry");
    workspace = { root: WORKSPACE_ROOT, packageManager: "npm", scripts, installExitCode: result.exitCode };
  } else {
    deps.log("info", "No package.json; skipping dependency install");
  }

  // 5. Checkpoint before any edit.
  let checkpointId: string;
  try {
    checkpointId = await sandbox.checkpoint(`shipfig ${input.jobId} base ${baseSha.slice(0, 12)}`);
  } catch (error) {
    throw new SetupError("checkpoint", `Checkpoint failed: ${(error as Error).message}`, "Retry the job");
  }
  deps.log("info", `Checkpoint ${checkpointId} taken before edits`);

  return { sandbox, spriteId: sandbox.id, baseBranch, baseSha, branchName, checkpointId, workspace };
}
