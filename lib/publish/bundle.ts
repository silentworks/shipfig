import { isSecretPath, normalizeRepoPath } from "@/lib/agent/paths";
import { policyViolations } from "@/lib/agent/policy";
import type { Sandbox } from "@/lib/sprites/sandbox";
import { captureDiff } from "@/lib/verify/evidence";
import type { BundleFile, GitFileMode, PublishBundle } from "./types";

/**
 * Take the exact approved change out of the job's workspace. Refuses unless
 * the workspace diff still hashes to the approved value, so what is published
 * is byte-for-byte what the human reviewed.
 */

export const MAX_FILE_BYTES = 1_000_000;
export const MAX_BUNDLE_BYTES = 8_000_000;

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

interface RawEntry {
  status: string;
  newMode: string;
  path: string;
}

/** Parse `git diff --raw -z --no-renames`: ":<old> <new> <oldsha> <newsha> <status>\0<path>\0". */
export function parseRawDiff(out: string): RawEntry[] {
  const parts = out.split("\0");
  const entries: RawEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i];
    if (!meta) continue;
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(meta);
    if (!m) throw new BundleError(`Unexpected git diff --raw output: ${JSON.stringify(meta.slice(0, 80))}`);
    entries.push({ newMode: m[2], status: m[3], path: parts[i + 1] });
  }
  return entries;
}

export async function collectBundle(
  sandbox: Sandbox,
  root: string,
  meta: { diffHash: string; baseSha: string; baseBranch: string; branchName: string },
  now = new Date(),
): Promise<PublishBundle> {
  const diff = await captureDiff(sandbox, root);
  if (diff.hash !== meta.diffHash) {
    throw new BundleError(`The workspace no longer matches the approved diff (${diff.hash.slice(0, 12)} ≠ ${meta.diffHash.slice(0, 12)}); nothing was published`);
  }

  const raw = await sandbox.run(["git", "diff", "--raw", "-z", "--no-renames", "--no-ext-diff", "HEAD"], { cwd: root, timeoutMs: 60_000, maxOutputChars: 400_000 });
  if (raw.exitCode !== 0) throw new BundleError(`git diff --raw failed (exit ${raw.exitCode})`);
  const entries = parseRawDiff(raw.stdout);
  if (entries.length === 0) throw new BundleError("The approved diff has no file changes");

  const paths = entries.map((e) => normalizeRepoPath(e.path));
  const violations = policyViolations(paths);
  if (violations.length > 0) throw new BundleError(`Protected files in the change: ${violations.map((v) => `${v.path} (${v.reason})`).join("; ")}`);
  const secret = paths.find(isSecretPath);
  if (secret) throw new BundleError(`Refusing to publish a secret-looking file: ${secret}`);

  const files: BundleFile[] = [];
  let total = 0;
  for (const entry of entries) {
    const path = normalizeRepoPath(entry.path);
    if (entry.status === "D") {
      files.push({ action: "delete", path });
      continue;
    }
    if (!["A", "M", "T"].includes(entry.status)) throw new BundleError(`Unsupported change ${entry.status} for ${path}`);
    if (entry.newMode !== "100644" && entry.newMode !== "100755") {
      throw new BundleError(`Refusing to publish ${path}: mode ${entry.newMode} (only regular files are published)`);
    }

    const size = await sandbox.run(["stat", "-c", "%s", "--", path], { cwd: root, timeoutMs: 30_000 });
    const bytes = Number(size.stdout.trim());
    if (size.exitCode !== 0 || !Number.isInteger(bytes)) throw new BundleError(`Could not stat ${path}`);
    if (bytes > MAX_FILE_BYTES) throw new BundleError(`${path} is ${bytes} bytes; the limit is ${MAX_FILE_BYTES}`);
    total += bytes;
    if (total > MAX_BUNDLE_BYTES) throw new BundleError(`The change is larger than ${MAX_BUNDLE_BYTES} bytes`);

    const expectedChars = 4 * Math.ceil(bytes / 3);
    const content = await sandbox.run(["base64", "-w0", "--", path], { cwd: root, timeoutMs: 30_000, maxOutputChars: expectedChars + 16 });
    const contentBase64 = content.stdout.trim();
    if (content.exitCode !== 0 || contentBase64.length !== expectedChars || !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) {
      throw new BundleError(`Could not read ${path} exactly`);
    }
    // --no-filters: hash the bytes as uploaded, so GitHub's blob sha must match.
    const hashed = await sandbox.run(["git", "hash-object", "--no-filters", "--", path], { cwd: root, timeoutMs: 30_000 });
    const blobSha = hashed.stdout.trim();
    if (hashed.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(blobSha)) throw new BundleError(`Could not hash ${path}`);

    files.push({ action: "upsert", path, mode: entry.newMode as GitFileMode, contentBase64, blobSha });
  }

  return { diffHash: meta.diffHash, baseSha: meta.baseSha, baseBranch: meta.baseBranch, branchName: meta.branchName, files, createdAt: now.toISOString() };
}
