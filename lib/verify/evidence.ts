import type { Check, PlanRecord } from "@/lib/agent/planner";
import type { TestResult } from "@/lib/jobs/store";
import type { Sandbox } from "@/lib/sprites/sandbox";
import { checkCommand } from "./checks";

/**
 * SIL-533: evidence. Everything here is derived from what actually happened
 * in the sandbox (exit codes, git state), never from what a model said.
 */

export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffFile {
  path: string;
  status: FileChangeStatus;
  additions: number | null;
  deletions: number | null;
}

export interface DiffEvidence {
  files: DiffFile[];
  additions: number;
  deletions: number;
  /** sha256 of the raw `git diff --binary HEAD`, computed inside the sprite. */
  hash: string;
  /** Unified diff as stored for review (redacted, possibly truncated). */
  patch: string;
  truncated: boolean;
}

export type VerificationOutcome = "verified" | "unverified" | "failed";

export interface Verification {
  /**
   * verified: every requested check had a script, ran and exited 0.
   * unverified: nothing failed, but some requested checks are missing (or none ran).
   * failed: at least one check did not pass.
   */
  outcome: VerificationOutcome;
  /** Requested checks that have no npm script (reported, never counted as passing). */
  missingChecks: Check[];
  /** Checks run on the untouched checkout before any edit. */
  baseline: TestResult[];
  diff: Omit<DiffEvidence, "patch">;
  /** Whether a test file was added or changed. */
  regressionTestChanged: boolean;
  /** Server-detected concerns. */
  flags: string[];
  review: Review | null;
  reviewError: string | null;
  createdAt: string;
}

export interface Review {
  verdict: "pass" | "fail";
  concerns: string[];
  evidence: string[];
}

const DIFF_FILE = "/tmp/shipfig-diff.patch";
const MAX_PATCH_CHARS = 200_000;

/** A short line describing what a test/lint/build run reported. */
export function summarizeOutput(output: string): string {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  const patterns: RegExp[] = [
    /^\s*Tests?\s+(\d+ (?:failed|passed)[^\n]*)$/im, // vitest: "Tests  1 failed | 3 passed (4)"
    /^Tests:\s+([^\n]+)$/im, // jest: "Tests: 1 failed, 2 passed, 3 total"
    /^#\s*(pass \d+)[\s\S]*?^#\s*(fail \d+)/im, // node:test TAP
    /^ℹ\s*(pass \d+)[\s\S]*?^ℹ\s*(fail \d+)/im, // node:test spec reporter
    /^\s*(\d+ passing[^\n]*)(?:[\s\S]*?^\s*(\d+ failing))?/im, // mocha
    /(Found \d+ errors?[^\n]*)/i, // tsc
    /(✖ \d+ problems?[^\n]*)/, // eslint
  ];
  for (const pattern of patterns) {
    const m = pattern.exec(text);
    if (m) return m.slice(1).filter(Boolean).join(", ").trim().slice(0, 200);
  }
  const last = text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  return (last ?? "(no output)").slice(0, 200);
}

/** Results entries for requested checks that have no script: explicit "not run". */
export function missingCheckResults(missing: readonly Check[]): TestResult[] {
  return missing.map((check) => ({
    name: check,
    command: checkCommand(check),
    status: "not_run",
    exitCode: null,
    durationMs: null,
    output: `No "${check}" script in package.json; this check was not run and is not counted as passing.`,
  }));
}

export function verificationOutcome(results: readonly TestResult[], missing: readonly Check[]): VerificationOutcome {
  const ran = results.filter((r) => r.status !== "not_run");
  if (ran.some((r) => r.status !== "passed" || r.exitCode !== 0)) return "failed";
  if (ran.length === 0 || missing.length > 0) return "unverified";
  return "verified";
}

function parseNumstat(out: string): Map<string, { additions: number | null; deletions: number | null }> {
  const map = new Map<string, { additions: number | null; deletions: number | null }>();
  // -z format: "<add>\t<del>\t<path>\0" or for renames "<add>\t<del>\t\0<old>\0<new>\0"
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(parts[i]);
    if (!m) continue;
    let path = m[3];
    if (path === "") {
      path = parts[i + 2] ?? "";
      i += 2;
    }
    map.set(path, { additions: m[1] === "-" ? null : Number(m[1]), deletions: m[2] === "-" ? null : Number(m[2]) });
  }
  return map;
}

function parseNameStatus(out: string): { path: string; status: FileChangeStatus }[] {
  const parts = out.split("\0").filter((p) => p !== "");
  const files: { path: string; status: FileChangeStatus }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i][0];
    if (code === "R" || code === "C") {
      files.push({ path: parts[i + 2], status: "renamed" });
      i += 2;
    } else {
      files.push({ path: parts[i + 1], status: code === "A" ? "added" : code === "D" ? "deleted" : "modified" });
      i += 1;
    }
  }
  return files;
}

/** Capture the change set against the base commit, with a hash of the raw diff. */
export async function captureDiff(sandbox: Sandbox, root: string): Promise<DiffEvidence> {
  const git = (args: string[], maxOutputChars = 400_000) => sandbox.run(["git", ...args], { cwd: root, timeoutMs: 60_000, maxOutputChars });
  const ita = await git(["add", "--intent-to-add", "--all"]);
  if (ita.exitCode !== 0) throw new Error(`git add -N failed (exit ${ita.exitCode})`);

  const written = await git(["diff", "--binary", "--no-color", "--no-ext-diff", `--output=${DIFF_FILE}`, "HEAD"]);
  if (written.exitCode !== 0) throw new Error(`git diff failed (exit ${written.exitCode})`);
  const hashed = await sandbox.run(["sha256sum", "--", DIFF_FILE], { cwd: root, timeoutMs: 30_000 });
  const hash = /^([0-9a-f]{64})\b/.exec(hashed.stdout)?.[1];
  if (!hash) throw new Error("Could not hash the diff");

  const [patch, numstat, nameStatus] = await Promise.all([
    git(["diff", "--no-color", "--no-ext-diff", "HEAD"], MAX_PATCH_CHARS + 1),
    git(["diff", "--numstat", "-z", "--no-ext-diff", "HEAD"]),
    git(["diff", "--name-status", "-z", "--no-ext-diff", "HEAD"]),
  ]);
  const stats = parseNumstat(numstat.stdout);
  const files = parseNameStatus(nameStatus.stdout).map((f) => ({ ...f, additions: stats.get(f.path)?.additions ?? null, deletions: stats.get(f.path)?.deletions ?? null }));
  const truncated = patch.stdout.length > MAX_PATCH_CHARS;
  return {
    files,
    additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
    deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
    hash,
    patch: truncated ? patch.stdout.slice(0, MAX_PATCH_CHARS) : patch.stdout,
    truncated,
  };
}

export function isTestFile(path: string): boolean {
  return /(^|\/)(__tests__|tests?|spec)\//i.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path);
}

/** Added lines in the patch that the redactor had to mask: likely secrets introduced by the change. */
export function secretsInPatch(patch: string): string[] {
  const hits: string[] = [];
  let file = "";
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) file = line.replace(/^\+\+\+ (b\/)?/, "");
    else if (line.startsWith("+") && line.includes("[REDACTED]")) hits.push(file);
  }
  return [...new Set(hits)];
}

/** Heuristic signs of weakened tests in the diff (flags for the reviewer and the human). */
export function testWeakeningSigns(patch: string): string[] {
  const signs = new Set<string>();
  const assertions = new Map<string, number>(); // net added assertion lines per test file
  let file = "";
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.replace(/^\+\+\+ (b\/)?/, "");
      continue;
    }
    if (line.startsWith("--- ") || !isTestFile(file)) continue;
    if (line.startsWith("+") && /\b(?:it|test|describe)\.(?:skip|only|todo)\b|\bx(?:it|describe)\s*\(/.test(line)) signs.add(`${file}: skipped or focused tests added`);
    if (/\b(expect|assert)\b/.test(line)) {
      if (line.startsWith("+")) assertions.set(file, (assertions.get(file) ?? 0) + 1);
      else if (line.startsWith("-")) assertions.set(file, (assertions.get(file) ?? 0) - 1);
    }
  }
  for (const [path, net] of assertions) if (net < 0) signs.add(`${path}: ${-net} fewer assertion line(s)`);
  return [...signs].sort();
}

export function evidenceFlags(input: { diff: DiffEvidence; plan: PlanRecord; baseline: readonly TestResult[]; results: readonly TestResult[] }): string[] {
  const flags: string[] = [];
  const { diff, plan } = input;
  if (!diff.files.some((f) => isTestFile(f.path) && f.status !== "deleted")) flags.push("No test file was added or changed (no regression test)");
  if (diff.files.some((f) => f.status === "deleted")) flags.push(`Files deleted: ${diff.files.filter((f) => f.status === "deleted").map((f) => f.path).join(", ")}`);
  const planned = new Set([...plan.existingFiles, ...plan.newFiles]);
  const unplanned = diff.files.map((f) => f.path).filter((p) => !planned.has(p));
  if (unplanned.length > 0) flags.push(`Changed files not in the approved plan: ${unplanned.join(", ")}`);
  if (plan.missingChecks.length > 0) flags.push(`Requested checks with no npm script (not run): ${plan.missingChecks.join(", ")}`);
  if (plan.runnableChecks.length === 0) flags.push("No checks could be run; the change is unverified");
  for (const base of input.baseline) {
    if (base.status !== "passed") flags.push(`${base.name} was already ${base.status === "timed_out" ? "timing out" : `failing (exit ${base.exitCode})`} before any change`);
  }
  for (const sign of testWeakeningSigns(diff.patch)) flags.push(`Possible test weakening: ${sign}`);
  if (diff.truncated) flags.push("Diff is too large to show in full");
  return flags;
}
