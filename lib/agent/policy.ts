import { isSecretPath, normalizeRepoPath } from "./paths";

/**
 * Write policy for the coding agent. The agent may only change ordinary
 * source, test and documentation files. Credentials, CI, deployment,
 * dependency manifests/lockfiles, git internals and installed packages are
 * protected. This is enforced on every write tool call and re-checked on the
 * final diff before anything can be published.
 */

const PROTECTED_DIRS = [".git", ".github", ".circleci", ".gitlab", ".buildkite", ".husky", "node_modules", ".do", ".fly", "k8s", "kubernetes", "helm", "charts", "terraform", "infra", "deploy", "deployment"];

const PROTECTED_FILES = new Set([
  // dependency manifests and lockfiles (no dependency changes; install scripts are disabled)
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  ".yarnrc",
  ".yarnrc.yml",
  ".npmrc",
  // CI
  ".gitlab-ci.yml",
  "jenkinsfile",
  "azure-pipelines.yml",
  ".travis.yml",
  "bitbucket-pipelines.yml",
  // deployment
  "fly.toml",
  "vercel.json",
  "netlify.toml",
  "render.yaml",
  "app.yaml",
  "app.json",
  "procfile",
  "wrangler.toml",
  "wrangler.json",
  "wrangler.jsonc",
  "serverless.yml",
  "railway.json",
  "railway.toml",
  // repository control
  ".gitmodules",
  ".gitattributes",
  "codeowners",
]);

export interface PolicyVerdict {
  ok: boolean;
  reason?: string;
}

export function writePolicy(path: string): PolicyVerdict {
  let rel: string;
  try {
    rel = normalizeRepoPath(path);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  const lower = rel.toLowerCase();
  const segments = lower.split("/");
  const base = segments.at(-1)!;
  if (isSecretPath(rel)) return { ok: false, reason: `${rel} may hold credentials` };
  const dir = segments.slice(0, -1).find((s) => PROTECTED_DIRS.includes(s));
  if (dir) return { ok: false, reason: `${rel} is under protected directory ${dir}/` };
  if (PROTECTED_FILES.has(base)) return { ok: false, reason: `${rel} is a protected file (dependencies, CI, deployment or repo control)` };
  if (/^dockerfile(\..*)?$|\.dockerfile$|^(docker-)?compose(\..*)?\.ya?ml$/.test(base)) return { ok: false, reason: `${rel} is deployment configuration` };
  if (/\.(tf|tfvars)$/.test(base)) return { ok: false, reason: `${rel} is infrastructure configuration` };
  return { ok: true };
}

/** Paths in a change set that violate the write policy. */
export function policyViolations(paths: readonly string[]): { path: string; reason: string }[] {
  return paths.flatMap((path) => {
    const verdict = writePolicy(path);
    return verdict.ok ? [] : [{ path, reason: verdict.reason! }];
  });
}
