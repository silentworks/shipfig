import type { Sandbox } from "@/lib/sprites/sandbox";

/**
 * Path rules for agent file access. Every path the model supplies is a
 * repository-relative path that is (1) syntactically normalised here and
 * (2) resolved with `realpath` inside the sprite so symlinks cannot escape the
 * checkout.
 */

export class PathPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathPolicyError";
  }
}

const MAX_PATH = 400;

/** Normalise a model-supplied repo path; throws on anything suspicious. */
export function normalizeRepoPath(input: string): string {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_PATH) throw new PathPolicyError("Path must be 1-400 characters");
  if (/[\0\r\n\\]/.test(input)) throw new PathPolicyError("Path contains forbidden characters");
  if (input.startsWith("/") || input.startsWith("~")) throw new PathPolicyError("Path must be relative to the repository root");
  const parts: string[] = [];
  for (const seg of input.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw new PathPolicyError("Path must not contain '..'");
    parts.push(seg);
  }
  if (parts.length === 0) throw new PathPolicyError("Path must name a file inside the repository");
  return parts.join("/");
}

/** Files whose contents must never be read by the model or sent to OpenAI. */
export function isSecretPath(path: string): boolean {
  const base = path.split("/").at(-1)!.toLowerCase();
  if (/^\.env(\..*)?$/.test(base) && base !== ".env.example" && base !== ".env.sample" && base !== ".env.template") return true;
  if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(base)) return true;
  if (/^(id_rsa|id_ed25519|id_ecdsa|\.npmrc|\.netrc|\.pypirc|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/.test(base)) return true;
  return false;
}

/**
 * Resolve a normalised relative path to an absolute path inside `root`,
 * following symlinks in the sprite. Rejects anything that lands outside.
 */
export async function resolveInside(sandbox: Sandbox, root: string, rel: string, mustExist: boolean): Promise<string> {
  const candidate = `${root}/${normalizeRepoPath(rel)}`;
  const result = await sandbox.run(["realpath", mustExist ? "-e" : "-m", "--", candidate], { cwd: root, timeoutMs: 15_000 });
  if (result.exitCode !== 0) {
    throw new PathPolicyError(mustExist ? `${rel} does not exist` : `Cannot resolve ${rel}`);
  }
  const resolved = result.stdout.trim();
  if (!resolved.startsWith(`${root}/`)) throw new PathPolicyError(`${rel} resolves outside the repository`);
  const relResolved = resolved.slice(root.length + 1);
  if (relResolved === ".git" || relResolved.startsWith(".git/")) throw new PathPolicyError("The .git directory is off limits");
  if (isSecretPath(relResolved)) throw new PathPolicyError(`${rel} may contain secrets and is off limits`);
  return resolved;
}
