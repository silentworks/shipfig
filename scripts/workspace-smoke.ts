/**
 * SIL-530 live check: provision a real job workspace for a public npm repo,
 * prove the sandbox restrictions hold, run the repo's own test script, then
 * delete the sprite.
 *
 *   npm run workspace-smoke -- <owner>/<repo>
 *
 * Uses the same provisioning code path and repo checks as a real job, so the
 * repo must pass SHIPFIG_ALLOWED_REPOS and the public/non-archived rules.
 */
import { randomBytes } from "node:crypto";
import { getAllowedRepo, getBranchHeadSha } from "@/lib/github/connector";
import { createJobSandbox, destroyJobSandbox } from "@/lib/sprites/sandbox";
import { parseRepoSlug } from "@/lib/validation";
import { WORKSPACE_ROOT, provisionWorkspace } from "@/lib/workspace/provision";

async function main() {
  const ref = parseRepoSlug(process.argv[2] ?? "");
  const jobId = randomBytes(6).toString("hex");
  const spriteName = `shipfig-smoke-${jobId}`;
  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures++;
    console.log(`[${ok ? "PASS" : "FAIL"}] ${msg}`);
  };
  try {
    const t0 = Date.now();
    const result = await provisionWorkspace(
      { jobId, owner: ref.owner, repo: ref.repo, issueNumber: 1, spriteName },
      {
        getAllowedRepo,
        getBranchHeadSha,
        createSandbox: createJobSandbox,
        log: (kind, message) => console.log(`  ${kind === "command" ? "" : "· "}${message}`),
      },
    );
    check(true, `provisioned in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${result.branchName} @ ${result.baseSha.slice(0, 12)}, checkpoint ${result.checkpointId}`);
    const sb = result.sandbox;

    const head = await sb.run(["git", "rev-parse", "HEAD"], { cwd: WORKSPACE_ROOT });
    check(head.stdout.trim() === result.baseSha, "HEAD is the pinned base SHA");
    const status = await sb.run(["git", "status", "--porcelain"], { cwd: WORKSPACE_ROOT });
    check(status.stdout.trim() === "", "checkout is clean after install (no tracked changes)");
    const egress = await sb.run(["curl", "-sS", "--max-time", "10", "-o", "/dev/null", "https://example.com"]);
    check(egress.exitCode !== 0, `egress to example.com blocked (exit ${egress.exitCode})`);
    const gw = await sb.run(["curl", "-sS", "--max-time", "10", "-o", "/dev/null", "https://api.sprites.dev"]);
    check(gw.exitCode !== 0, `Sprites API / connector gateway unreachable from job sprite (exit ${gw.exitCode})`);
    const sudo = await sb.run(["sudo", "-n", "true"]);
    check(sudo.exitCode !== 0, "no privilege escalation (sudo refused)");
    const env = await sb.run(["env"]);
    check(!/gh[pousr]_|github_pat_|SPRITES_TOKEN/.test(env.stdout), "no tokens in job sprite environment");

    if (result.workspace.scripts.test) {
      const test = await sb.run(["npm", "test"], { cwd: WORKSPACE_ROOT, timeoutMs: 5 * 60_000 });
      console.log(`[INFO] npm test → ${test.timedOut ? "timed out" : `exit ${test.exitCode}`} in ${(test.durationMs / 1000).toFixed(1)}s`);
      console.log(test.stdout.split("\n").slice(-8).join("\n"));
    } else {
      console.log("[INFO] repo has no test script");
    }
  } catch (error) {
    failures++;
    console.log(`[FAIL] ${(error as Error).message}`);
  } finally {
    await destroyJobSandbox(spriteName).catch(() => {});
    console.log(`[INFO] deleted ${spriteName}`);
  }
  console.log(failures === 0 ? "\nWorkspace smoke PASSED" : `\nWorkspace smoke FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
