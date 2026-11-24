"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { Issue, Repo } from "@/lib/github/schemas";
import type { Job } from "@/lib/jobs/store";
import { ApiError, fetchJson, useResource } from "./api";
import { Button, ErrorNotice, Loading, Muted, Panel } from "./ui";

// Mirrors lib/validation; the server re-validates everything.
const REPO_PARAM = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const ISSUE_PARAM = /^[1-9][0-9]{0,9}$/;

interface RepoListing {
  repos: Repo[];
  excluded: { fullName: string; reason: string }[];
}

function errorMessage(error: Error): string {
  if (error instanceof ApiError && error.code === "not_configured") {
    return `Shipfig is not configured: ${error.message}`;
  }
  return error.message;
}

export function IssuePicker() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const repoParam = searchParams.get("repo");
  const issueParam = searchParams.get("issue");
  const selectedRepo = repoParam && REPO_PARAM.test(repoParam) ? repoParam : null;
  const selectedIssue = selectedRepo && issueParam && ISSUE_PARAM.test(issueParam) ? Number(issueParam) : null;

  const repos = useResource<RepoListing>("/api/repos");
  const issues = useResource<{ issues: Issue[] }>(selectedRepo ? `/api/repos/${selectedRepo}/issues` : null);
  const issue = useResource<{ issue: Issue }>(
    selectedRepo && selectedIssue ? `/api/repos/${selectedRepo}/issues/${selectedIssue}` : null,
  );

  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<{ message: string; activeJobId?: string } | null>(null);

  function select(params: { repo?: string | null; issue?: number | null }) {
    const next = new URLSearchParams();
    const repo = params.repo === undefined ? selectedRepo : params.repo;
    const iss = params.issue === undefined ? selectedIssue : params.issue;
    if (repo) next.set("repo", repo);
    if (repo && iss) next.set("issue", String(iss));
    setStartError(null);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  const issueReady = issue.status === "ok" && issue.data.issue.state === "open";

  async function run() {
    if (!selectedRepo || !selectedIssue || !issueReady) return;
    const [owner, repo] = selectedRepo.split("/");
    setStarting(true);
    setStartError(null);
    try {
      const { job } = await fetchJson<{ job: Job }>("/api/jobs", {
        method: "POST",
        body: JSON.stringify({ owner, repo, issueNumber: selectedIssue }),
      });
      router.push(`/jobs/${job.id}`);
    } catch (error) {
      const details = error instanceof ApiError ? (error.details as { activeJobId?: string } | undefined) : undefined;
      setStartError({ message: errorMessage(error as Error), activeJobId: details?.activeJobId });
      setStarting(false);
    }
  }

  return (
    <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="flex min-h-0 flex-col gap-4">
        <Panel title="Repository">
          {repos.status === "loading" && <Loading label="Loading repositories" />}
          {repos.status === "error" && <ErrorNotice message={errorMessage(repos.error)} onRetry={repos.reload} />}
          {repos.status === "ok" && repos.data.repos.length === 0 && (
            <Muted>
              No eligible repositories. Shipfig works on public, non-archived repositories the GitHub connector can see
              {repos.data.excluded.length > 0 ? ` (${repos.data.excluded.length} excluded)` : ""}.
            </Muted>
          )}
          {repos.status === "ok" && repos.data.repos.length > 0 && (
            <div className="flex flex-col gap-2">
              <label htmlFor="repo" className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Select a repository
              </label>
              <select
                id="repo"
                value={selectedRepo ?? ""}
                onChange={(e) => select({ repo: e.target.value || null, issue: null })}
                className="h-9 rounded-md border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="">Choose…</option>
                {repos.data.repos.map((r) => (
                  <option key={r.fullName} value={r.fullName}>
                    {r.fullName}
                  </option>
                ))}
              </select>
              {repos.data.excluded.length > 0 && (
                <details className="text-xs text-zinc-500 dark:text-zinc-400">
                  <summary className="cursor-pointer">{repos.data.excluded.length} repositories excluded</summary>
                  <ul className="mt-1 list-disc pl-4">
                    {repos.data.excluded.map((r) => (
                      <li key={r.fullName}>
                        {r.fullName}: {r.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </Panel>

        <Panel title="Open issues" actions={selectedRepo && issues.status === "ok" ? <IssueCount n={issues.data.issues.length} /> : null}>
          {!selectedRepo && <Muted>Select a repository to see its open issues.</Muted>}
          {issues.status === "loading" && <Loading label="Loading issues" />}
          {issues.status === "error" && <ErrorNotice message={errorMessage(issues.error)} onRetry={issues.reload} />}
          {issues.status === "ok" && issues.data.issues.length === 0 && <Muted>This repository has no open issues.</Muted>}
          {issues.status === "ok" && issues.data.issues.length > 0 && (
            <fieldset className="flex max-h-[28rem] flex-col gap-1 overflow-y-auto">
              <legend className="sr-only">Select an issue</legend>
              {issues.data.issues.map((i) => {
                const checked = i.number === selectedIssue;
                return (
                  <label
                    key={i.number}
                    className={`flex cursor-pointer items-start gap-3 rounded-md px-3 py-2 text-sm ${
                      checked ? "bg-zinc-100 dark:bg-zinc-800" : "hover:bg-zinc-50 dark:hover:bg-zinc-900"
                    }`}
                  >
                    <input
                      type="radio"
                      name="issue"
                      value={i.number}
                      checked={checked}
                      onChange={() => select({ issue: i.number })}
                      className="mt-1"
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-zinc-900 dark:text-zinc-100">{i.title}</span>
                      <span className="text-xs text-zinc-500">
                        #{i.number}
                        {i.author ? ` · ${i.author}` : ""}
                        {i.labels.length > 0 ? ` · ${i.labels.join(", ")}` : ""}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}
        </Panel>
      </div>

      <Panel
        title="Issue"
        actions={
          <Button onClick={run} disabled={!issueReady || starting} aria-describedby="run-hint">
            {starting ? "Starting…" : "Run Shipfig"}
          </Button>
        }
      >
        <p id="run-hint" className="sr-only">
          Starts a job for the selected issue. A plan is shown for approval before any code runs.
        </p>
        {startError && (
          <div className="mb-4">
            <ErrorNotice message={startError.message} />
            {startError.activeJobId && (
              <Link href={`/jobs/${startError.activeJobId}`} className="mt-2 inline-block text-sm font-medium underline">
                View active job
              </Link>
            )}
          </div>
        )}
        {!selectedIssue && <Muted>Select an issue to see its details. Nothing runs until you press Run.</Muted>}
        {issue.status === "loading" && <Loading label="Loading issue" />}
        {issue.status === "error" && <ErrorNotice message={errorMessage(issue.error)} onRetry={issue.reload} />}
        {issue.status === "ok" && <IssueDetail issue={issue.data.issue} repo={selectedRepo!} />}
      </Panel>
    </div>
  );
}

function IssueCount({ n }: { n: number }) {
  return <span className="text-xs text-zinc-500">{n === 50 ? "50 most recent" : n}</span>;
}

function IssueDetail({ issue, repo }: { issue: Issue; repo: string }) {
  return (
    <article className="flex flex-col gap-3">
      <div>
        <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          {issue.title} <span className="font-normal text-zinc-500">#{issue.number}</span>
        </h3>
        <p className="text-xs text-zinc-500">
          {repo} · {issue.state}
          {issue.author ? ` · opened by ${issue.author}` : ""} · updated {new Date(issue.updatedAt).toLocaleString()}
          {" · "}
          <a href={issue.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
            View on GitHub
          </a>
        </p>
        {issue.state !== "open" && <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">Only open issues can be run.</p>}
      </div>
      {/* Issue text is untrusted: rendered as plain text, never as HTML/markdown. */}
      <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-3 font-sans text-sm text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
        {issue.body.trim() || "No description provided."}
      </pre>
    </article>
  );
}
