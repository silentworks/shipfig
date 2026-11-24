import type { Check } from "@/lib/agent/planner";
import type { TestResult } from "@/lib/jobs/store";
import type { Sandbox } from "@/lib/sprites/sandbox";

/**
 * Run approved npm checks in the job sandbox. The result for each check is
 * derived only from the real process exit code: `passed` means it ran and
 * exited 0; a timeout is `timed_out`; anything else is `failed`.
 */

export const CHECK_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_TAIL_CHARS = 6_000;

export function checkCommand(check: Check): string[] {
  return check === "test" ? ["npm", "test"] : ["npm", "run", check];
}

/** Keep the end of the output, where test runners print failures and totals. */
export function tail(text: string, max = OUTPUT_TAIL_CHARS): string {
  return text.length <= max ? text : `[... ${text.length - max} characters omitted]\n${text.slice(-max)}`;
}

export async function runCheck(sandbox: Sandbox, root: string, check: Check, timeoutMs = CHECK_TIMEOUT_MS): Promise<TestResult> {
  const command = checkCommand(check);
  const result = await sandbox.run(command, { cwd: root, timeoutMs, maxOutputChars: 60_000 });
  const output = [result.stdout, result.stderr].filter((s) => s.trim()).join("\n--- stderr ---\n");
  return {
    name: check,
    command,
    status: result.timedOut ? "timed_out" : result.exitCode === 0 ? "passed" : "failed",
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    output: tail(output),
  };
}

export async function runChecks(sandbox: Sandbox, root: string, checks: readonly Check[]): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const check of checks) results.push(await runCheck(sandbox, root, check));
  return results;
}

/** Files changed relative to the base commit, including new untracked files (gitignored files excluded). */
export async function changedFiles(sandbox: Sandbox, root: string): Promise<string[]> {
  const result = await sandbox.run(["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`git status failed (exit ${result.exitCode})`);
  const entries = result.stdout.split("\0").filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const status = entry.slice(0, 2);
    files.push(entry.slice(3));
    if (status.startsWith("R") || status.startsWith("C")) i++; // skip the rename source
  }
  return files;
}
