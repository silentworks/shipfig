import { z } from "zod";
import { serverEnv } from "@/lib/env";
import { githubGatewayRequest } from "@/lib/sprites/gateway";
import { type IssueRef, type RepoRef, branchNameSchema, issueRefSchema, pathSegment, repoRefSchema, repoSlug } from "@/lib/validation";
import { type Issue, type Repo, githubIssueSchema, githubRepoSchema, githubUserSchema, toIssue, toRepo } from "./schemas";

/**
 * Typed GitHub operations over the Sprites connector gateway. Every input is
 * validated before it becomes part of a request path.
 */

function repoPath(ref: RepoRef): string {
  const { owner, repo } = repoRefSchema.parse(ref);
  return `/repos/${pathSegment(owner)}/${pathSegment(repo)}`;
}

export class RepoNotAllowedError extends Error {
  constructor(
    public readonly repo: string,
    reason: string,
  ) {
    super(`Repository ${repo} is not available to Shipfig: ${reason}`);
    this.name = "RepoNotAllowedError";
  }
}

export async function getViewer(): Promise<{ login: string; url: string }> {
  const { data } = await githubGatewayRequest("/user");
  const user = githubUserSchema.parse(data);
  return { login: user.login, url: user.html_url };
}

export async function getRepo(ref: RepoRef): Promise<Repo> {
  const { data } = await githubGatewayRequest(repoPath(ref));
  return toRepo(githubRepoSchema.parse(data));
}

export async function getIssue(ref: IssueRef): Promise<Issue> {
  const { issueNumber, ...repo } = issueRefSchema.parse(ref);
  const { data } = await githubGatewayRequest(`${repoPath(repo)}/issues/${pathSegment(issueNumber)}`);
  const raw = githubIssueSchema.parse(data);
  if (raw.pull_request !== undefined) {
    throw new Error(`#${issueNumber} is a pull request, not an issue`);
  }
  return toIssue(raw);
}

/** Whether a repo passes the configured allowlist (empty allowlist = any). */
export function isAllowlisted(ref: RepoRef, allowlist: readonly string[]): boolean {
  return allowlist.length === 0 || allowlist.includes(repoSlug(ref).toLowerCase());
}

/**
 * Repository eligibility for the MVP: allowlisted, public (job sprites clone
 * anonymously over HTTPS), and not archived.
 */
export function eligibility(repo: Repo, allowlist: readonly string[]): { ok: true } | { ok: false; reason: string } {
  if (!isAllowlisted({ owner: repo.owner, repo: repo.name }, allowlist)) return { ok: false, reason: "not in SHIPFIG_ALLOWED_REPOS" };
  if (repo.private) return { ok: false, reason: "private repositories are not supported yet" };
  if (repo.archived) return { ok: false, reason: "repository is archived" };
  return { ok: true };
}

export interface RepoListing {
  repos: Repo[];
  /** Repos the connector can see but Shipfig will not operate on, with the reason. */
  excluded: { fullName: string; reason: string }[];
}

/**
 * Repositories the user may pick. With an allowlist, exactly those repos are
 * fetched; otherwise the connected account's repos are listed.
 */
export async function listAllowedRepos(): Promise<RepoListing> {
  const allowlist = serverEnv().SHIPFIG_ALLOWED_REPOS;
  let candidates: Repo[];
  const excluded: RepoListing["excluded"] = [];

  if (allowlist.length > 0) {
    const results = await Promise.allSettled(
      allowlist.map((slug) => {
        const [owner, repo] = slug.split("/");
        return getRepo({ owner, repo });
      }),
    );
    candidates = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") candidates.push(r.value);
      else excluded.push({ fullName: allowlist[i], reason: r.reason instanceof Error ? r.reason.message : "could not be loaded" });
    });
  } else {
    const { data } = await githubGatewayRequest("/user/repos", {
      query: { per_page: 100, sort: "updated", affiliation: "owner,collaborator,organization_member" },
    });
    candidates = z.array(githubRepoSchema).parse(data).map(toRepo);
  }

  const repos: Repo[] = [];
  for (const repo of candidates) {
    const verdict = eligibility(repo, allowlist);
    if (verdict.ok) repos.push(repo);
    else excluded.push({ fullName: repo.fullName, reason: verdict.reason });
  }
  repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return { repos, excluded };
}

/** Fetch a repo and throw unless Shipfig may operate on it. */
export async function getAllowedRepo(ref: RepoRef): Promise<Repo> {
  const allowlist = serverEnv().SHIPFIG_ALLOWED_REPOS;
  const slug = repoSlug(repoRefSchema.parse(ref));
  // Check the allowlist before making any request for a non-allowlisted repo.
  if (!isAllowlisted(ref, allowlist)) throw new RepoNotAllowedError(slug, "not in SHIPFIG_ALLOWED_REPOS");
  const repo = await getRepo(ref);
  const verdict = eligibility(repo, allowlist);
  if (!verdict.ok) throw new RepoNotAllowedError(slug, verdict.reason);
  return repo;
}

/** Open issues (pull requests excluded), most recently updated first. */
export async function listOpenIssues(ref: RepoRef): Promise<Issue[]> {
  await getAllowedRepo(ref);
  const { data } = await githubGatewayRequest(`${repoPath(ref)}/issues`, {
    query: { state: "open", per_page: 50, sort: "updated", direction: "desc" },
  });
  return z
    .array(githubIssueSchema)
    .parse(data)
    .filter((raw) => raw.pull_request === undefined)
    .map(toIssue);
}

/** A single issue from an allowed repo. */
export async function getAllowedIssue(ref: IssueRef): Promise<Issue> {
  const parsed = issueRefSchema.parse(ref);
  await getAllowedRepo(parsed);
  return getIssue(parsed);
}

const gitRefSchema = z.object({ object: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/), type: z.string() }) });

/** Current head commit SHA of a branch (used to pin the job's base commit). */
export async function getBranchHeadSha(ref: RepoRef, branch: string): Promise<string> {
  const name = branchNameSchema.parse(branch);
  const path = `${repoPath(ref)}/git/ref/heads/${name.split("/").map(pathSegment).join("/")}`;
  const { data } = await githubGatewayRequest(path);
  const parsed = gitRefSchema.parse(data);
  if (parsed.object.type !== "commit") throw new Error(`refs/heads/${name} does not point at a commit`);
  return parsed.object.sha;
}
