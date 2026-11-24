import { z } from "zod";
import type { Sandbox } from "@/lib/sprites/sandbox";
import { type Tool, defineTool } from "./loop";
import { PathPolicyError, isSecretPath, normalizeRepoPath, resolveInside } from "./paths";

/**
 * Read-only tools over a job checkout: list tracked files, read a file (or a
 * line range), and fixed-string search. Shared by the planner (SIL-531) and the
 * executor (SIL-532). Reads are capped per call and per session.
 */

export const READ_LIMITS = {
  maxFileChars: 60_000,
  maxSessionReadChars: 400_000,
  maxListEntries: 400,
  maxSearchChars: 12_000,
};

export class ReadBudget {
  used = 0;
  readonly files = new Set<string>();
  constructor(readonly limit = READ_LIMITS.maxSessionReadChars) {}

  take(path: string, chars: number): void {
    if (this.used + chars > this.limit) {
      throw new PathPolicyError(`Read budget exhausted (${this.used}/${this.limit} characters); work with what you have`);
    }
    this.used += chars;
    this.files.add(path);
  }
}

export async function listTrackedFiles(sandbox: Sandbox, root: string, dir?: string | null): Promise<string[]> {
  const scope = dir ? normalizeRepoPath(dir) : ".";
  const result = await sandbox.run(["git", "ls-files", "-z", "--", scope], { cwd: root, timeoutMs: 30_000, maxOutputChars: 400_000 });
  if (result.exitCode !== 0) throw new Error(`git ls-files failed (exit ${result.exitCode})`);
  return result.stdout.split("\0").filter(Boolean);
}

/** Read a file through the path policy; returns the raw text and whether it was cut. */
export async function readRepoFile(sandbox: Sandbox, root: string, path: string, maxChars = READ_LIMITS.maxFileChars) {
  const rel = normalizeRepoPath(path);
  const abs = await resolveInside(sandbox, root, rel, true);
  const result = await sandbox.run(["head", "-c", String(maxChars + 1), "--", abs], { cwd: root, timeoutMs: 15_000, maxOutputChars: maxChars + 1000 });
  if (result.exitCode !== 0) throw new PathPolicyError(`Cannot read ${rel}: ${result.stderr.trim().slice(0, 200) || `exit ${result.exitCode}`}`);
  if (result.stdout.includes("\0")) throw new PathPolicyError(`${rel} looks binary; not readable`);
  const truncated = result.stdout.length > maxChars;
  return { path: rel, text: truncated ? result.stdout.slice(0, maxChars) : result.stdout, truncated };
}

export function numberLines(text: string, start = 1): string {
  return text
    .split("\n")
    .map((line, i) => `${String(start + i).padStart(4)}| ${line}`)
    .join("\n");
}

export function readOnlyTools(sandbox: Sandbox, root: string, budget = new ReadBudget()): Tool[] {
  return [
    defineTool({
      name: "list_files",
      description: "List git-tracked files in the repository, optionally under one directory.",
      parameters: z.object({ directory: z.string().max(400).nullable().describe("Repo-relative directory, or null for the whole repo") }),
      async handler({ directory }) {
        const files = await listTrackedFiles(sandbox, root, directory);
        const shown = files.slice(0, READ_LIMITS.maxListEntries);
        const more = files.length - shown.length;
        return shown.join("\n") + (more > 0 ? `\n... (${more} more; list a subdirectory)` : "") || "(no tracked files)";
      },
    }),
    defineTool({
      name: "read_file",
      description: "Read a repository file with line numbers. Optionally pass a 1-based inclusive line range for large files.",
      parameters: z.object({
        path: z.string().max(400).describe("Repo-relative file path"),
        startLine: z.number().int().min(1).nullable(),
        endLine: z.number().int().min(1).nullable(),
      }),
      async handler({ path, startLine, endLine }) {
        const file = await readRepoFile(sandbox, root, path);
        const lines = file.text.split("\n");
        const from = startLine ?? 1;
        const to = Math.min(endLine ?? lines.length, lines.length);
        const body = lines.slice(from - 1, to).join("\n");
        budget.take(file.path, body.length);
        const note = file.truncated ? `\n[file truncated at ${READ_LIMITS.maxFileChars} characters]` : "";
        return `${file.path} (lines ${from}-${to} of ${lines.length}${file.truncated ? "+" : ""})\n${numberLines(body, from)}${note}`;
      },
    }),
    defineTool({
      name: "search_code",
      description: "Search tracked files for a fixed string (not a regex). Returns matching lines with file and line number.",
      parameters: z.object({
        query: z.string().min(2).max(200),
        directory: z.string().max(400).nullable(),
      }),
      async handler({ query, directory }) {
        const scope = directory ? normalizeRepoPath(directory) : ".";
        const result = await sandbox.run(["git", "grep", "-n", "-I", "-F", "--max-count=20", "-e", query, "--", scope], {
          cwd: root,
          timeoutMs: 30_000,
          maxOutputChars: READ_LIMITS.maxSearchChars,
        });
        if (result.exitCode === 1) return "(no matches)";
        if (result.exitCode !== 0) throw new Error(`search failed (exit ${result.exitCode})`);
        // Never echo lines from secret files.
        return result.stdout
          .split("\n")
          .filter((line) => line && !isSecretPath(line.split(":")[0]))
          .join("\n");
      },
    }),
  ];
}
