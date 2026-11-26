import { z } from "zod";
import { EnvError, serverEnv } from "@/lib/env";
import { GatewayError, githubGatewayRequest } from "@/lib/sprites/gateway";
import { type IssueRef, type RepoRef, branchNameSchema, issueRefSchema, pathSegment, repoRefSchema, repoSlug } from "@/lib/validation";
import { type Issue, type Repo, githubIssueSchema, githubRepoSchema, githubUserSchema, toIssue, toRepo } from "./schemas";
import type { GitHubRequestFn } from "./user-client";
import { combineAllowlists } from "./user-repos";

function serverAllowedRepos(): readonly string[] {
  try {
    return serverEnv().SHIPFIG_ALLOWED_REPOS;
  } catch (error) {
    if (error instanceof EnvError) {
      const raw = process.env.SHIPFIG_ALLOWED_REPOS?.trim();
      if (!raw) return [];
      return raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    }
    throw error;
  }
}

/**
 * Typed GitHub operations over the Sprites connector gateway or a user's
 * linked GitHub OAuth / GitHub App client. Every input is validated before it
 * becomes part of a request path.
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

export async function getViewer(request: GitHubRequestFn = githubGatewayRequest): Promise<{ login: string; url: string }> {
  const { data } = await request("/user");
  const user = githubUserSchema.parse(data);
  return { login: user.login, url: user.html_url };
}

export async function getRepo(ref: RepoRef, request: GitHubRequestFn = githubGatewayRequest): Promise<Repo> {
  const { data } = await request(repoPath(ref));
  return toRepo(githubRepoSchema.parse(data));
}

export async function getIssue(ref: IssueRef, request: GitHubRequestFn = githubGatewayRequest): Promise<Issue> {
  const { issueNumber, ...repo } = issueRefSchema.parse(ref);
  const { data } = await request(`${repoPath(repo)}/issues/${pathSegment(issueNumber)}`);
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
  if (!isAllowlisted({ owner: repo.owner, repo: repo.name }, allowlist)) {
    return { ok: false, reason: "not selected for Shipfig" };
  }
  if (repo.private) return { ok: false, reason: "private repositories are not supported yet" };
  if (repo.archived) return { ok: false, reason: "repository is archived" };
  return { ok: true };
}

export interface RepoListing {
  repos: Repo[];
  /** Repos the connector can see but Shipfig will not operate on, with the reason. */
  excluded: { fullName: string; reason: string }[];
  /** Where the candidate list was fetched from. */
  source?: "installations" | "oauth" | "allowlist";
}

const installationsResponseSchema = z.object({
  installations: z.array(z.object({ id: z.number().int().positive() })),
});

const installationReposResponseSchema = z.object({
  repositories: z.array(githubRepoSchema),
});

/**
 * Fetch repositories via GitHub App user installations when available
 * (honoring GitHub's "Only select repositories" installation picker),
 * falling back to `/user/repos` for classic OAuth App tokens.
 */
async function fetchCandidateRepos(
  request: GitHubRequestFn,
  useAppInstallations: boolean,
): Promise<{ candidates: Repo[]; source: "installations" | "oauth" }> {
  if (useAppInstallations) {
    try {
      const { data } = await request("/user/installations", { query: { per_page: 100 } });
      const { installations } = installationsResponseSchema.parse(data);
      if (installations.length > 0) {
        const seen = new Map<string, Repo>();
        const results = await Promise.allSettled(
          installations.map((inst) =>
            request(`/user/installations/${inst.id}/repositories`, { query: { per_page: 100 } }),
          ),
        );
        for (const r of results) {
          if (r.status !== "fulfilled") continue;
          const parsed = installationReposResponseSchema.parse(r.value.data);
          for (const raw of parsed.repositories) {
            const repo = toRepo(raw);
            seen.set(repo.fullName.toLowerCase(), repo);
          }
        }
        return { candidates: Array.from(seen.values()), source: "installations" };
      }
    } catch (error) {
      // Classic OAuth Apps return 403/404 on /user/installations; fall back to /user/repos.
      if (!(error instanceof GatewayError && (error.kind === "forbidden" || error.kind === "not_found"))) {
        throw error;
      }
    }
  }

  const { data } = await request("/user/repos", {
    query: { per_page: 100, sort: "updated", affiliation: "owner,collaborator,organization_member" },
  });
  return { candidates: z.array(githubRepoSchema).parse(data).map(toRepo), source: "oauth" };
}

export interface ListReposOptions {
  /** Optional per-user selected repositories to intersect with server allowlist. */
  userSelectedRepos?: readonly string[];
  /** Try GitHub App `/user/installations` before `/user/repos`. Defaults to true for user clients. */
  useAppInstallations?: boolean;
}

/**
 * Repositories the user may pick. Combines any server-wide `SHIPFIG_ALLOWED_REPOS`
 * with the user's selected repositories (when provided).
 */
export async function listAllowedRepos(
  request: GitHubRequestFn = githubGatewayRequest,
  options: ListReposOptions = {},
): Promise<RepoListing> {
  const serverAllowlist = serverAllowedRepos();
  const allowlist = combineAllowlists(serverAllowlist, options.userSelectedRepos);
  const useAppInstallations = options.useAppInstallations ?? request !== githubGatewayRequest;

  let candidates: Repo[];
  let source: RepoListing["source"] = "oauth";
  const excluded: RepoListing["excluded"] = [];

  if (allowlist.length > 0 && options.userSelectedRepos === undefined) {
    source = "allowlist";
    const results = await Promise.allSettled(
      allowlist.map((slug) => {
        const [owner, repo] = slug.split("/");
        return getRepo({ owner, repo }, request);
      }),
    );
    candidates = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") candidates.push(r.value);
      else excluded.push({ fullName: allowlist[i], reason: r.reason instanceof Error ? r.reason.message : "could not be loaded" });
    });
  } else {
    const fetched = await fetchCandidateRepos(request, useAppInstallations);
    candidates = fetched.candidates;
    source = fetched.source;
  }

  const repos: Repo[] = [];
  for (const repo of candidates) {
    const verdict = eligibility(repo, allowlist);
    if (verdict.ok) repos.push(repo);
    else if (!options.userSelectedRepos?.length || isAllowlisted({ owner: repo.owner, repo: repo.name }, allowlist)) {
      excluded.push({ fullName: repo.fullName, reason: verdict.reason });
    }
  }
  repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return { repos, excluded, source };
}

/** Fetch a repo and throw unless Shipfig may operate on it. */
export async function getAllowedRepo(
  ref: RepoRef,
  request: GitHubRequestFn = githubGatewayRequest,
  userSelectedRepos?: readonly string[],
): Promise<Repo> {
  const allowlist = combineAllowlists(serverAllowedRepos(), userSelectedRepos);
  const slug = repoSlug(repoRefSchema.parse(ref));
  // Check the allowlist before making any request for a non-allowlisted repo.
  if (!isAllowlisted(ref, allowlist)) {
    throw new RepoNotAllowedError(slug, userSelectedRepos?.length ? "not in your selected repositories" : "not in SHIPFIG_ALLOWED_REPOS");
  }
  const repo = await getRepo(ref, request);
  const verdict = eligibility(repo, allowlist);
  if (!verdict.ok) throw new RepoNotAllowedError(slug, verdict.reason);
  return repo;
}

/** Open issues (pull requests excluded), most recently updated first. */
export async function listOpenIssues(
  ref: RepoRef,
  request: GitHubRequestFn = githubGatewayRequest,
  userSelectedRepos?: readonly string[],
): Promise<Issue[]> {
  await getAllowedRepo(ref, request, userSelectedRepos);
  const { data } = await request(`${repoPath(ref)}/issues`, {
    query: { state: "open", per_page: 50, sort: "updated", direction: "desc" },
  });
  return z
    .array(githubIssueSchema)
    .parse(data)
    .filter((raw) => raw.pull_request === undefined)
    .map(toIssue);
}

/** A single issue from an allowed repo. */
export async function getAllowedIssue(
  ref: IssueRef,
  request: GitHubRequestFn = githubGatewayRequest,
  userSelectedRepos?: readonly string[],
): Promise<Issue> {
  const parsed = issueRefSchema.parse(ref);
  await getAllowedRepo(parsed, request, userSelectedRepos);
  return getIssue(parsed, request);
}

const gitRefSchema = z.object({ object: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/), type: z.string() }) });

/** Current head commit SHA of a branch (used to pin the job's base commit). */
export async function getBranchHeadSha(ref: RepoRef, branch: string, request: GitHubRequestFn = githubGatewayRequest): Promise<string> {
  const name = branchNameSchema.parse(branch);
  const path = `${repoPath(ref)}/git/ref/heads/${name.split("/").map(pathSegment).join("/")}`;
  const { data } = await request(path);
  const parsed = gitRefSchema.parse(data);
  if (parsed.object.type !== "commit") throw new Error(`refs/heads/${name} does not point at a commit`);
  return parsed.object.sha;
}
