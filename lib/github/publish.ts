import { z } from "zod";
import { GatewayError, githubGatewayRequest } from "@/lib/sprites/gateway";
import { type RepoRef, branchNameSchema, pathSegment, repoRefSchema } from "@/lib/validation";
import type { PublishBundle, PublishResult } from "@/lib/publish/types";

/**
 * SIL-534: publish an approved bundle as a branch and a draft PR using the Git
 * database API through the connector gateway (never `git push`, which the
 * connector does not authorize, and never from the job sprite).
 *
 * Idempotent by construction: blobs and trees are content-addressed; the
 * branch name is unique to the job, so an existing branch is reused only if
 * it already holds exactly this tree on the pinned base, and an existing PR
 * for the branch is reused rather than duplicated. Nothing is force-pushed,
 * deleted or merged.
 */

export type GitHubRequest = typeof githubGatewayRequest;

export class PublishConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishConflictError";
  }
}

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const shaOnly = z.object({ sha });
const commitSchema = z.object({ sha, tree: z.object({ sha }), parents: z.array(z.object({ sha })) });
const refSchema = z.object({ object: z.object({ sha, type: z.string() }) });
const pullSchema = z.object({ number: z.number().int().positive(), html_url: z.url(), state: z.string(), draft: z.boolean().optional() });

function repoPath(ref: RepoRef): string {
  const { owner, repo } = repoRefSchema.parse(ref);
  return `/repos/${pathSegment(owner)}/${pathSegment(repo)}`;
}

function refPath(branch: string): string {
  return branchNameSchema.parse(branch).split("/").map(pathSegment).join("/");
}

function isStatus(error: unknown, status: number): boolean {
  return error instanceof GatewayError && error.status === status;
}

export interface PullRequestDraft {
  title: string;
  body: string;
  commitMessage: string;
}

export async function publishBundleToGitHub(
  ref: RepoRef,
  bundle: PublishBundle,
  /** Builds the PR text once Shipfig knows whether the base branch moved. */
  draft: (context: { baseMoved: boolean }) => PullRequestDraft,
  options: { request?: GitHubRequest; log?: (message: string) => void; now?: () => Date } = {},
): Promise<PublishResult> {
  const gh = options.request ?? githubGatewayRequest;
  const log = options.log ?? (() => {});
  const base = repoPath(ref);
  const branch = branchNameSchema.parse(bundle.branchName);
  if (!branch.startsWith("shipfig/")) throw new PublishConflictError(`Refusing to publish to ${branch}: Shipfig only writes shipfig/* branches`);
  if (bundle.files.length === 0) throw new PublishConflictError("The bundle has no changes to publish");

  // 1. The pinned base commit (and whether the base branch has moved since).
  const baseCommit = commitSchema.parse((await gh(`${base}/git/commits/${bundle.baseSha}`)).data);
  const baseHead = refSchema.parse((await gh(`${base}/git/ref/heads/${refPath(bundle.baseBranch)}`)).data).object.sha;
  const baseMoved = baseHead !== bundle.baseSha;
  if (baseMoved) log(`${bundle.baseBranch} moved since the job started (${bundle.baseSha.slice(0, 12)} → ${baseHead.slice(0, 12)}); the PR is based on the pinned commit`);
  const pr = draft({ baseMoved });

  // 2. Blobs: GitHub's blob sha must equal the git hash computed in the sprite.
  const entries: { path: string; mode: string; type: "blob"; sha: string | null }[] = [];
  for (const file of bundle.files) {
    if (file.action === "delete") {
      entries.push({ path: file.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    const blob = shaOnly.parse((await gh(`${base}/git/blobs`, { method: "POST", body: { content: file.contentBase64, encoding: "base64" } })).data);
    if (blob.sha !== file.blobSha) {
      throw new PublishConflictError(`Content of ${file.path} changed in transit (blob ${blob.sha.slice(0, 12)} ≠ ${file.blobSha.slice(0, 12)})`);
    }
    entries.push({ path: file.path, mode: file.mode, type: "blob", sha: blob.sha });
  }
  log(`Uploaded ${entries.filter((e) => e.sha).length} blob(s)`);

  // 3. Tree on top of the base tree.
  const tree = shaOnly.parse((await gh(`${base}/git/trees`, { method: "POST", body: { base_tree: baseCommit.tree.sha, tree: entries } })).data);

  // 4. Commit + branch, reusing an earlier attempt's identical commit.
  const existingCommit = async (): Promise<string | null> => {
    let head: string;
    try {
      head = refSchema.parse((await gh(`${base}/git/ref/heads/${refPath(branch)}`)).data).object.sha;
    } catch (error) {
      if (isStatus(error, 404)) return null;
      throw error;
    }
    const commit = commitSchema.parse((await gh(`${base}/git/commits/${head}`)).data);
    if (commit.tree.sha === tree.sha && commit.parents.length === 1 && commit.parents[0].sha === bundle.baseSha) return commit.sha;
    throw new PublishConflictError(`Branch ${branch} already exists with different content; Shipfig will not overwrite it`);
  };

  let commitSha = await existingCommit();
  const reusedCommit = commitSha !== null;
  if (commitSha) {
    log(`Branch ${branch} already holds this change (${commitSha.slice(0, 12)}); reusing it`);
  } else {
    const commit = shaOnly.parse(
      (await gh(`${base}/git/commits`, { method: "POST", body: { message: pr.commitMessage, tree: tree.sha, parents: [bundle.baseSha] } })).data,
    );
    try {
      await gh(`${base}/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
      commitSha = commit.sha;
      log(`Created branch ${branch} at ${commit.sha.slice(0, 12)}`);
    } catch (error) {
      if (!isStatus(error, 422)) throw error;
      // Created concurrently (or by a lost response): accept it only if it is the same change.
      commitSha = await existingCommit();
      if (!commitSha) throw error;
    }
  }

  // 5. Draft PR, reusing an existing one for this branch.
  const findPull = async () => {
    const { data } = await gh(`${base}/pulls`, { query: { head: `${repoRefSchema.parse(ref).owner}:${branch}`, state: "all", per_page: 10 } });
    return z.array(pullSchema).parse(data)[0] ?? null;
  };
  let pull = await findPull();
  const reusedPull = pull !== null;
  if (pull) {
    log(`Pull request #${pull.number} already exists for ${branch}; reusing it`);
  } else {
    try {
      pull = pullSchema.parse(
        (await gh(`${base}/pulls`, { method: "POST", body: { title: pr.title, head: branch, base: bundle.baseBranch, body: pr.body, draft: true } })).data,
      );
      log(`Opened draft pull request #${pull.number}`);
    } catch (error) {
      if (!isStatus(error, 422)) throw error;
      pull = await findPull();
      if (!pull) throw error;
    }
  }

  return {
    branch,
    commitSha,
    treeSha: tree.sha,
    prNumber: pull.number,
    prUrl: pull.html_url,
    prState: pull.state,
    draft: pull.draft ?? true,
    reused: { commit: reusedCommit, pullRequest: reusedPull },
    baseMoved,
    publishedAt: (options.now?.() ?? new Date()).toISOString(),
  };
}
