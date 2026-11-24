import { githubGatewayRequest } from "@/lib/sprites/gateway";
import { type IssueRef, type RepoRef, issueRefSchema, pathSegment, repoRefSchema } from "@/lib/validation";
import { type Issue, type Repo, githubIssueSchema, githubRepoSchema, githubUserSchema, toIssue, toRepo } from "./schemas";

/**
 * Typed GitHub operations over the Sprites connector gateway. Every input is
 * validated before it becomes part of a request path.
 */

function repoPath(ref: RepoRef): string {
  const { owner, repo } = repoRefSchema.parse(ref);
  return `/repos/${pathSegment(owner)}/${pathSegment(repo)}`;
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
