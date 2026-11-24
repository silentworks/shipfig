"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import type { Issue, Repo } from "@/lib/github/schemas";
import type { Job } from "@/lib/jobs/store";
import { ApiError, fetchJson, useResource } from "./api";
import { Button, EmptyState, ErrorNotice, Loading, Muted, StatusBadge } from "./ui";

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

  const [filter, setFilter] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<{ message: string; activeJobId?: string } | null>(null);

  function select(params: { repo?: string | null; issue?: number | null }) {
    const next = new URLSearchParams();
    const repo = params.repo === undefined ? selectedRepo : params.repo;
    const iss = params.issue === undefined ? selectedIssue : params.issue;
    if (repo) next.set("repo", repo);
    if (repo && iss) next.set("issue", String(iss));
    if (params.repo !== undefined && params.repo !== selectedRepo) setFilter("");
    setStartError(null);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  const filteredIssues = useMemo(() => {
    if (issues.status !== "ok") return [];
    const q = filter.trim().toLowerCase();
    if (!q) return issues.data.issues;
    return issues.data.issues.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        String(i.number).includes(q) ||
        i.labels.some((l) => l.toLowerCase().includes(q)) ||
        (i.author && i.author.toLowerCase().includes(q)),
    );
  }, [issues, filter]);

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
    <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      {/* Left pane: unified repo selector + searchable issues list */}
      <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-zinc-200/80 bg-white dark:border-zinc-800/80 dark:bg-zinc-950">
        <div className="flex flex-col gap-2.5 border-b border-zinc-200/80 p-3 dark:border-zinc-800/80">
          {repos.status === "loading" && <Loading label="Loading repositories" />}
          {repos.status === "error" && <ErrorNotice message={errorMessage(repos.error)} onRetry={repos.reload} />}
          {repos.status === "ok" && repos.data.repos.length === 0 && (
            <Muted className="text-xs">
              No eligible repositories. Shipfig works on public, non-archived repositories visible to the GitHub connector
              {repos.data.excluded.length > 0 ? ` (${repos.data.excluded.length} excluded)` : ""}.
            </Muted>
          )}
          {repos.status === "ok" && repos.data.repos.length > 0 && (
            <>
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="repo" className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                  Repository
                </label>
                {selectedRepo && issues.status === "ok" && (
                  <span className="text-[11px] text-zinc-400">
                    {issues.data.issues.length === 50 ? "50 most recent" : `${issues.data.issues.length} open`}
                  </span>
                )}
              </div>
              <select
                id="repo"
                value={selectedRepo ?? ""}
                onChange={(e) => select({ repo: e.target.value || null, issue: null })}
                className="h-8 w-full rounded-md border border-zinc-200 bg-zinc-50/70 px-2.5 text-xs font-medium text-zinc-900 transition-colors hover:border-zinc-300 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
              >
                <option value="">Select a repository…</option>
                {repos.data.repos.map((r) => (
                  <option key={r.fullName} value={r.fullName}>
                    {r.fullName}
                  </option>
                ))}
              </select>

              {selectedRepo && issues.status === "ok" && issues.data.issues.length > 0 && (
                <div className="relative">
                  <svg
                    aria-hidden
                    viewBox="0 0 16 16"
                    fill="none"
                    className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400"
                  >
                    <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M10.5 10.5L13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                  <input
                    type="search"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter issues by title, #, or label…"
                    aria-label="Filter open issues"
                    className="h-8 w-full rounded-md border border-zinc-200/80 bg-transparent pl-8 pr-2.5 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:text-zinc-100"
                  />
                </div>
              )}

              {repos.data.excluded.length > 0 && (
                <details className="text-[11px] text-zinc-500">
                  <summary className="cursor-pointer hover:text-zinc-700 dark:hover:text-zinc-300">
                    {repos.data.excluded.length} excluded {repos.data.excluded.length === 1 ? "repository" : "repositories"}
                  </summary>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {repos.data.excluded.map((r) => (
                      <li key={r.fullName}>
                        <span className="font-mono">{r.fullName}</span>: {r.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {!selectedRepo && (
            <EmptyState
              title="Choose a repository"
              description="Pick a repository above to browse its open GitHub issues."
            />
          )}
          {issues.status === "loading" && (
            <div className="p-3">
              <Loading label="Loading issues" />
            </div>
          )}
          {issues.status === "error" && (
            <div className="p-3">
              <ErrorNotice message={errorMessage(issues.error)} onRetry={issues.reload} />
            </div>
          )}
          {issues.status === "ok" && issues.data.issues.length === 0 && (
            <EmptyState title="No open issues" description="This repository has no open issues right now." />
          )}
          {issues.status === "ok" && issues.data.issues.length > 0 && filteredIssues.length === 0 && (
            <EmptyState title="No matching issues" description={`Nothing matched "${filter}".`} />
          )}
          {issues.status === "ok" && filteredIssues.length > 0 && (
            <fieldset className="flex max-h-[34rem] flex-col divide-y divide-zinc-100 dark:divide-zinc-900">
              <legend className="sr-only">Select an issue</legend>
              {filteredIssues.map((i) => {
                const checked = i.number === selectedIssue;
                return (
                  <label
                    key={i.number}
                    className={`relative flex cursor-pointer items-start gap-2.5 px-3.5 py-2.5 text-sm transition-colors ${
                      checked
                        ? "bg-zinc-100/90 dark:bg-zinc-900"
                        : "hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                    }`}
                  >
                    {checked && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-zinc-900 dark:bg-zinc-100" />}
                    <input
                      type="radio"
                      name="issue"
                      value={i.number}
                      checked={checked}
                      onChange={() => select({ issue: i.number })}
                      className="sr-only"
                    />
                    <span className="mt-0.5 shrink-0 font-mono text-xs text-zinc-400">#{i.number}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">{i.title}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
                        {i.author && <span>{i.author}</span>}
                        {i.labels.slice(0, 3).map((label) => (
                          <span
                            key={label}
                            className="rounded border border-zinc-200/80 bg-zinc-50 px-1.5 py-0 text-[10px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
                          >
                            {label}
                          </span>
                        ))}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}
        </div>
      </section>

      {/* Right pane: issue preview + sticky primary CTA */}
      <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-zinc-200/80 bg-white dark:border-zinc-800/80 dark:bg-zinc-950">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200/80 px-4 py-2.5 dark:border-zinc-800/80">
          <div className="min-w-0">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Issue details</h2>
          </div>
          <Button onClick={run} disabled={!issueReady || starting} aria-describedby="run-hint">
            {starting ? "Starting…" : "Run Shipfig"}
          </Button>
        </header>

        <div className="min-h-0 flex-1 p-5">
          <p id="run-hint" className="sr-only">
            Starts a job for the selected issue. A plan is shown for approval before any code runs.
          </p>
          {startError && (
            <div className="mb-4">
              <ErrorNotice message={startError.message} />
              {startError.activeJobId && (
                <Link
                  href={`/jobs/${startError.activeJobId}`}
                  className="mt-2 inline-block text-xs font-medium text-zinc-900 underline underline-offset-2 dark:text-zinc-100"
                >
                  Open active job →
                </Link>
              )}
            </div>
          )}

          {!selectedIssue && (
            <EmptyState
              icon={
                <svg aria-hidden viewBox="0 0 16 16" fill="none" className="h-4 w-4">
                  <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" />
                  <circle cx="8" cy="8" r="1.5" fill="currentColor" />
                </svg>
              }
              title="No issue selected"
              description="Select an issue from the list to inspect its details. Nothing runs until you press Run Shipfig, and Shipfig always asks for your approval before editing or opening a PR."
            />
          )}
          {issue.status === "loading" && <Loading label="Loading issue" />}
          {issue.status === "error" && <ErrorNotice message={errorMessage(issue.error)} onRetry={issue.reload} />}
          {issue.status === "ok" && <IssueDetail issue={issue.data.issue} repo={selectedRepo!} />}
        </div>
      </section>
    </div>
  );
}

function IssueDetail({ issue, repo }: { issue: Issue; repo: string }) {
  return (
    <article className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={issue.state === "open" ? "completed" : "neutral"}>{issue.state}</StatusBadge>
          <span className="font-mono text-xs text-zinc-500">
            {repo}#{issue.number}
          </span>
          <a
            href={issue.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-xs text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline dark:hover:text-zinc-100"
          >
            GitHub ↗
          </a>
        </div>

        <h3 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">{issue.title}</h3>

        <p className="text-xs text-zinc-500">
          {issue.author ? `Opened by ${issue.author} · ` : ""}
          Updated <time dateTime={issue.updatedAt}>{new Date(issue.updatedAt).toLocaleString()}</time>
        </p>

        {issue.labels.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {issue.labels.map((label) => (
              <span
                key={label}
                className="rounded-full border border-zinc-200/80 bg-zinc-50 px-2 py-0.5 text-[11px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
              >
                {label}
              </span>
            ))}
          </div>
        )}

        {issue.state !== "open" && (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
            Only open issues can be run.
          </p>
        )}
      </div>

      {/* Issue text is untrusted: rendered as plain text, never as HTML/markdown. */}
      <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-200/80 bg-zinc-50/70 p-4 font-sans text-sm leading-relaxed text-zinc-800 dark:border-zinc-800/80 dark:bg-zinc-900/50 dark:text-zinc-200">
        {issue.body.trim() || "No description provided."}
      </pre>
    </article>
  );
}
