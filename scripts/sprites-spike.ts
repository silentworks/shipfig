/**
 * SIL-527 integration spike: proves Sprites + GitHub Connector access end to end.
 *
 *   npm run spike -- <owner>/<repo> <issue-number>
 *
 * Steps (each prints PASS/FAIL/INFO):
 *  1. Validate env and list GitHub connectors (metadata only — no tokens).
 *  2. Create a throwaway sprite from TypeScript and execute a command in it.
 *  3. Confirm a non-gateway sprite is DENIED by the connector policy.
 *  4. From the trusted gateway sprite, fetch the viewer, repo and issue.
 *  5. Confirm no GitHub token is present in either sprite's environment.
 *  6. Probe whether authenticated git transport works through the gateway.
 *  7. Clean up the throwaway sprite.
 */
import { randomBytes } from "node:crypto";
import { ExecError, type Sprite } from "@fly/sprites";
import { serverEnv } from "@/lib/env";
import { getIssue, getRepo, getViewer } from "@/lib/github/connector";
import { redact } from "@/lib/redact";
import { spritesClient } from "@/lib/sprites/client";
import { listConnections } from "@/lib/sprites/connections";
import { gatewaySprite } from "@/lib/sprites/gateway";
import { parseRepoSlug, issueNumberSchema } from "@/lib/validation";

let failures = 0;
const log = (status: "PASS" | "FAIL" | "INFO" | "WARN", msg: string) => {
  if (status === "FAIL") failures++;
  console.log(`[${status}] ${redact(msg)}`);
};

const TOKEN_PATTERN = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/;

async function run(sprite: Sprite, file: string, args: string[], env?: Record<string, string>) {
  try {
    const r = await sprite.execFile(file, args, { timeout: 60_000, env });
    return { exitCode: r.exitCode, stdout: String(r.stdout), stderr: String(r.stderr) };
  } catch (error) {
    if (error instanceof ExecError) {
      return { exitCode: error.exitCode, stdout: String(error.stdout), stderr: String(error.stderr) };
    }
    throw error;
  }
}

async function main() {
  const [slug, issueArg] = process.argv.slice(2);
  if (!slug || !issueArg) {
    console.error("usage: npm run spike -- <owner>/<repo> <issue-number>");
    process.exit(2);
  }
  const repo = parseRepoSlug(slug);
  const issueNumber = issueNumberSchema.parse(issueArg);

  // 1. Env + connectors
  const env = serverEnv();
  log("PASS", "environment validated");
  const connections = await listConnections("github");
  for (const c of connections) {
    log(
      "INFO",
      `connector ${c.id} account=${c.provider_account_name ?? "?"} scopes=${c.scopes ?? "?"} policy=${JSON.stringify(c.access_policy ?? null)}`,
    );
  }
  if (!connections.some((c) => c.id === env.SHIPFIG_GITHUB_CONNECTION_ID)) {
    log("FAIL", `SHIPFIG_GITHUB_CONNECTION_ID=${env.SHIPFIG_GITHUB_CONNECTION_ID} not found among GitHub connectors`);
  }

  // 2. Throwaway sprite + command execution
  const testName = `shipfig-spike-${randomBytes(4).toString("hex")}`;
  log("INFO", `creating test sprite ${testName}`);
  const test = await spritesClient().createSprite(testName, { config: { ramMB: 512, cpus: 1 }, waitForCapacity: true });
  try {
    const uname = await run(test, "sh", ["-c", "uname -sr && node --version && git --version && curl --version | head -1"]);
    log(uname.exitCode === 0 ? "PASS" : "FAIL", `exec in sprite exit=${uname.exitCode}: ${uname.stdout.trim().replace(/\n/g, " | ")}`);

    // 3. Untrusted (non-gateway) sprite must be denied by the connector policy
    const url = `${env.SPRITES_API_URL}/v1/gateway/github/${env.SHIPFIG_GITHUB_CONNECTION_ID}/repos/${repo.owner}/${repo.repo}`;
    const denied = await run(test, "curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--", url]);
    const deniedStatus = denied.stdout.trim();
    log(
      deniedStatus === "403" || deniedStatus === "401" ? "PASS" : "FAIL",
      `non-gateway sprite gateway call returned ${deniedStatus} (expected 401/403: policy must only admit the gateway sprite)`,
    );

    // 5a. No token in test sprite env
    const testEnv = await run(test, "env", []);
    log(TOKEN_PATTERN.test(testEnv.stdout) ? "FAIL" : "PASS", "no GitHub token in job-style sprite environment");
  } finally {
    // 7. Cleanup
    await test.delete().then(
      () => log("INFO", `deleted ${testName}`),
      (e) => log("WARN", `could not delete ${testName}: ${e}`),
    );
  }

  // 4. Gateway sprite: authenticated connector requests
  const gw = await gatewaySprite();
  log("INFO", `gateway sprite ${gw.name} labels=${gw.labels.join(",")}`);
  try {
    const viewer = await getViewer();
    log("PASS", `connector authenticated as ${viewer.login}`);
  } catch (e) {
    log("WARN", `GET /user failed (may be blocked by policy): ${e instanceof Error ? e.message : e}`);
  }
  const repoInfo = await getRepo(repo);
  log("PASS", `repo ${repoInfo.fullName} private=${repoInfo.private} default=${repoInfo.defaultBranch} canPush=${repoInfo.canPush}`);
  const issue = await getIssue({ ...repo, issueNumber });
  log("PASS", `issue #${issue.number} "${issue.title}" state=${issue.state} ${issue.url}`);

  // 5b. No token in gateway sprite env
  const gwEnv = await run(gw, "env", []);
  log(TOKEN_PATTERN.test(gwEnv.stdout) ? "FAIL" : "PASS", "no GitHub token in gateway sprite environment");

  // 6. Git transport probe (expected to fail: gateway is documented for REST only)
  const gitUrl = `${env.SPRITES_API_URL}/v1/gateway/github/${env.SHIPFIG_GITHUB_CONNECTION_ID}/${repo.owner}/${repo.repo}.git`;
  const ls = await run(gw, "git", ["ls-remote", "--heads", "--", gitUrl], { GIT_TERMINAL_PROMPT: "0" });
  log(
    "INFO",
    `git ls-remote via gateway exit=${ls.exitCode} (${ls.exitCode === 0 ? "git transport WORKS" : "no authenticated git transport; use REST git database API for publishing"}): ${ls.stderr.trim().slice(0, 200)}`,
  );
  const publicClone = await run(gw, "git", ["ls-remote", "--heads", "--", repoInfo.cloneUrl], { GIT_TERMINAL_PROMPT: "0" });
  log(
    publicClone.exitCode === 0 || repoInfo.private ? "INFO" : "FAIL",
    `anonymous HTTPS ls-remote of ${repoInfo.cloneUrl} exit=${publicClone.exitCode}`,
  );

  console.log(failures === 0 ? "\nSpike PASSED" : `\nSpike FAILED (${failures} failure(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`[FAIL] ${redact(error instanceof Error ? (error.stack ?? error.message) : String(error))}`);
  process.exit(1);
});
