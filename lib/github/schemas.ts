import { z } from "zod";

/**
 * Narrow schemas for the GitHub API responses Shipfig uses. Only the fields we
 * need are kept; everything else is dropped. Issue title/body are untrusted
 * user content and must only ever be rendered as plain text or passed to the
 * model as quoted data.
 */

export const githubUserSchema = z.object({
  login: z.string(),
  html_url: z.url(),
});

export const githubRepoSchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  owner: z.object({ login: z.string() }),
  private: z.boolean(),
  html_url: z.url(),
  clone_url: z.url(),
  default_branch: z.string(),
  description: z.string().nullable(),
  open_issues_count: z.number(),
  archived: z.boolean().optional().default(false),
  permissions: z
    .object({ admin: z.boolean().optional(), push: z.boolean().optional(), pull: z.boolean().optional() })
    .optional(),
});
export type GitHubRepo = z.infer<typeof githubRepoSchema>;

export const githubIssueSchema = z.object({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  html_url: z.url(),
  user: z.object({ login: z.string() }).nullable(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string().nullable().optional() })])).default([]),
  comments: z.number().default(0),
  created_at: z.string(),
  updated_at: z.string(),
  /** Present when the "issue" is actually a pull request. */
  pull_request: z.unknown().optional(),
});
export type GitHubIssueRaw = z.infer<typeof githubIssueSchema>;

/** Issue shape exposed to the app (labels normalised, PR marker dropped). */
export interface Issue {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  author: string | null;
  labels: string[];
  comments: number;
  createdAt: string;
  updatedAt: string;
}

export function toIssue(raw: GitHubIssueRaw): Issue {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state,
    url: raw.html_url,
    author: raw.user?.login ?? null,
    labels: raw.labels
      .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
      .filter((l): l is string => l.length > 0),
    comments: raw.comments,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

/** Repository shape exposed to the app. */
export interface Repo {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  url: string;
  cloneUrl: string;
  defaultBranch: string;
  description: string | null;
  openIssuesCount: number;
  archived: boolean;
  canPush: boolean;
}

export function toRepo(raw: GitHubRepo): Repo {
  return {
    owner: raw.owner.login,
    name: raw.name,
    fullName: raw.full_name,
    private: raw.private,
    url: raw.html_url,
    cloneUrl: raw.clone_url,
    defaultBranch: raw.default_branch,
    description: raw.description,
    openIssuesCount: raw.open_issues_count,
    archived: raw.archived,
    canPush: Boolean(raw.permissions?.push),
  };
}
