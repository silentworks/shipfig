"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { Issue, Repo } from "@/lib/github/schemas";
import type { Job } from "@/lib/jobs/store";
import { ActiveJobBanner } from "./active-job-banner";
import { ApiError, fetchJson, useResource } from "./api";
import { Markdown } from "./markdown";
import { Button, EmptyState, ErrorNotice, Loading } from "./ui";

// Mirrors lib/validation; the server re-validates everything.
const REPO_PARAM = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const ISSUE_PARAM = /^[1-9][0-9]{0,9}$/;

interface RepoListing {
  repos: Repo[];
  excluded: { fullName: string; reason: string }[];
}

const LABEL_STYLES = [
  "border-emerald-200/90 bg-emerald-50 text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/60 dark:text-emerald-300",
  "border-amber-200/90 bg-amber-50 text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/60 dark:text-amber-300",
  "border-rose-200/90 bg-rose-50 text-rose-700 dark:border-rose-800/60 dark:bg-rose-950/60 dark:text-rose-300",
  "border-sky-200/90 bg-sky-50 text-sky-700 dark:border-sky-800/60 dark:bg-sky-950/60 dark:text-sky-300",
  "border-violet-200/90 bg-violet-50 text-violet-700 dark:border-violet-800/60 dark:bg-violet-950/60 dark:text-violet-300",
];

function labelStyle(label: string, selected: boolean): string {
  if (selected) {
    return "border-sky-200/90 bg-white/80 text-sky-700 dark:border-sky-800/70 dark:bg-sky-950/70 dark:text-sky-300";
  }
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return LABEL_STYLES[hash % LABEL_STYLES.length];
}

function relativeTime(iso: string): string {
  const diffSec = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (Number.isNaN(diffSec) || diffSec < 60) return "just now";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins} ${mins === 1 ? "minute" : "minutes"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} ${hrs === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

  // Auto-select the first eligible repository when landing on / with none chosen.
  useEffect(() => {
    if (!selectedRepo && repos.status === "ok" && repos.data.repos.length > 0) {
      const first = repos.data.repos[0].fullName;
      router.replace(`${pathname}?repo=${encodeURIComponent(first)}`, { scroll: false });
    }
  }, [selectedRepo, repos, pathname, router]);

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
  const repoShortName = selectedRepo ? selectedRepo.split("/")[1] ?? selectedRepo : null;

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
    <div className="flex min-h-0 flex-1 flex-col md:flex-row md:overflow-hidden">
      {/* Column 2: Issue list pane (GitScout-inspired) */}
      <section
        aria-label="Open issues"
        className="flex min-h-0 w-full shrink-0 flex-col border-b border-zinc-200/80 bg-white md:w-80 md:border-b-0 md:border-r lg:w-[22rem] dark:border-zinc-800/80 dark:bg-zinc-950"
      >
        {/* Top search bar */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-200/80 px-3.5 dark:border-zinc-800/80">
          <svg aria-hidden viewBox="0 0 16 16" fill="none" className="h-4 w-4 shrink-0 text-zinc-400">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5L13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search"
            aria-label="Search open issues"
            className="w-full bg-transparent text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-100"
          />
          {selectedRepo && issues.status === "ok" && (
            <span className="shrink-0 text-xs text-zinc-400">{filteredIssues.length}</span>
          )}
        </div>

        {/* Mobile-only repository selector (desktop uses sidebar) */}
        {repos.status === "ok" && repos.data.repos.length > 0 && (
          <div className="border-b border-zinc-200/80 px-3.5 py-2 md:hidden dark:border-zinc-800/80">
            <select
              aria-label="Repository"
              value={selectedRepo ?? ""}
              onChange={(e) => select({ repo: e.target.value || null, issue: null })}
              className="h-8 w-full rounded-md border border-zinc-200 bg-zinc-50 px-2 text-xs font-medium text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
            >
              <option value="">Select a repository…</option>
              {repos.data.repos.map((r) => (
                <option key={r.fullName} value={r.fullName}>
                  {r.fullName}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Scrollable issue cards */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {repos.status === "loading" && (
            <div className="p-4">
              <Loading label="Loading repositories" />
            </div>
          )}
          {repos.status === "error" && (
            <div className="p-4">
              <ErrorNotice message={errorMessage(repos.error)} onRetry={repos.reload} />
            </div>
          )}
          {repos.status === "ok" && repos.data.repos.length === 0 && (
            <EmptyState
              title="No eligible repositories"
              description="Connect a public, non-archived GitHub repository to start picking issues."
            />
          )}
          {selectedRepo && issues.status === "loading" && (
            <div className="p-4">
              <Loading label="Loading issues" />
            </div>
          )}
          {selectedRepo && issues.status === "error" && (
            <div className="p-4">
              <ErrorNotice message={errorMessage(issues.error)} onRetry={issues.reload} />
            </div>
          )}
          {selectedRepo && issues.status === "ok" && issues.data.issues.length === 0 && (
            <EmptyState title="No open issues" description={`${selectedRepo} has no open issues right now.`} />
          )}
          {selectedRepo && issues.status === "ok" && issues.data.issues.length > 0 && filteredIssues.length === 0 && (
            <EmptyState title="No matches" description={`No issues match "${filter}".`} />
          )}

          {selectedRepo && issues.status === "ok" && filteredIssues.length > 0 && (
            <fieldset className="flex flex-col divide-y divide-zinc-200/70 dark:divide-zinc-800/70">
              <legend className="sr-only">Select an issue</legend>
              {filteredIssues.map((i) => {
                const checked = i.number === selectedIssue;
                return (
                  <label
                    key={i.number}
                    className={`relative block cursor-pointer px-4 py-3.5 transition-colors ${
                      checked
                        ? "bg-sky-50/80 dark:bg-sky-950/35"
                        : "hover:bg-zinc-50/80 dark:hover:bg-zinc-900/50"
                    }`}
                  >
                    {checked && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-sky-500" />}
                    <input
                      type="radio"
                      name="issue"
                      value={i.number}
                      checked={checked}
                      onChange={() => select({ issue: i.number })}
                      className="sr-only"
                    />

                    {/* Row 1: #number · repo + relative time */}
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className={`truncate ${checked ? "text-sky-700 dark:text-sky-300" : "text-zinc-500"}`}>
                        <span className={`font-semibold ${checked ? "text-sky-700 dark:text-sky-300" : "text-zinc-700 dark:text-zinc-300"}`}>
                          #{i.number}
                        </span>
                        {repoShortName && (
                          <>
                            {" · "}
                            <span>{repoShortName}</span>
                          </>
                        )}
                      </span>
                      <time
                        dateTime={i.updatedAt}
                        className={`shrink-0 text-[11px] ${checked ? "text-sky-600 dark:text-sky-400" : "text-zinc-400"}`}
                      >
                        {relativeTime(i.updatedAt)}
                      </time>
                    </div>

                    {/* Row 2: Issue title */}
                    <p
                      className={`mt-1 line-clamp-2 text-sm font-semibold leading-snug ${
                        checked ? "text-sky-700 dark:text-sky-200" : "text-zinc-900 dark:text-zinc-100"
                      }`}
                    >
                      {i.title}
                    </p>

                    {/* Row 3: Colored label pills */}
                    {i.labels.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {i.labels.slice(0, 4).map((label) => (
                          <span
                            key={label}
                            className={`rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none ${labelStyle(label, checked)}`}
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Row 4: Author */}
                    {i.author && (
                      <p className={`mt-2 text-xs ${checked ? "text-sky-600/90 dark:text-sky-300/80" : "text-zinc-400 dark:text-zinc-500"}`}>
                        Opened by{" "}
                        <span className={`font-medium ${checked ? "text-sky-700 dark:text-sky-200" : "text-zinc-600 dark:text-zinc-300"}`}>
                          @{i.author}
                        </span>
                      </p>
                    )}
                  </label>
                );
              })}
            </fieldset>
          )}
        </div>
      </section>

      {/* Column 3: Issue detail canvas */}
      <section aria-label="Issue details" className="flex min-h-0 min-w-0 flex-1 flex-col bg-zinc-50/50 dark:bg-zinc-950/60">
        {!selectedIssue ? (
          <div className="flex flex-1 flex-col justify-center p-6">
            <div className="mx-auto w-full max-w-md">
              <ActiveJobBanner />
              <EmptyState
                icon={
                  <svg aria-hidden viewBox="0 0 16 16" fill="none" className="h-4 w-4">
                    <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" />
                    <circle cx="8" cy="8" r="1.5" fill="currentColor" />
                  </svg>
                }
                title="Select an issue"
                description="Pick an issue from the list to inspect its details. When you click Run Shipfig, Shipfig drafts a plan for your approval before making any edits."
              />
            </div>
          </div>
        ) : (
          <>
            {/* Top header */}
            <header className="shrink-0 border-b border-zinc-200/80 bg-white px-6 py-4 dark:border-zinc-800/80 dark:bg-zinc-950">
              {issue.status === "loading" && <Loading label="Loading issue" />}
              {issue.status === "error" && <ErrorNotice message={errorMessage(issue.error)} onRetry={issue.reload} />}
              {issue.status === "ok" && (
                <div className="flex flex-col gap-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs">
                      <span
                        className={`rounded px-2 py-0.5 font-semibold ${
                          issue.data.issue.state === "open"
                            ? "bg-emerald-500 text-white"
                            : "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                        }`}
                      >
                        #{issue.data.issue.number}
                      </span>
                      <span className="text-zinc-500">{selectedRepo}</span>
                    </div>

                    <div className="flex items-center gap-2.5">
                      <a
                        href={issue.data.issue.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-zinc-500 hover:text-zinc-900 hover:underline dark:hover:text-zinc-100"
                      >
                        View on GitHub ↗
                      </a>
                      <Button onClick={run} disabled={!issueReady || starting} aria-describedby="run-hint">
                        {starting ? "Starting…" : "Run Shipfig"}
                      </Button>
                    </div>
                  </div>

                  <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
                    {issue.data.issue.title}
                  </h1>

                  <div className="flex flex-wrap items-center gap-2">
                    {issue.data.issue.labels.map((label) => (
                      <span
                        key={label}
                        className={`rounded border px-2 py-0.5 text-xs font-medium leading-none ${labelStyle(label, false)}`}
                      >
                        {label}
                      </span>
                    ))}
                    <span className="text-xs text-zinc-500">
                      {issue.data.issue.author ? (
                        <>
                          Opened by <span className="font-medium text-zinc-700 dark:text-zinc-300">@{issue.data.issue.author}</span> ·{" "}
                        </>
                      ) : null}
                      Updated {relativeTime(issue.data.issue.updatedAt)}
                    </span>
                  </div>
                </div>
              )}
            </header>

            {/* Scrollable body card */}
            <div className="min-h-0 flex-1 overflow-y-auto p-6">
              <p id="run-hint" className="sr-only">
                Starts a job for the selected issue. A plan is shown for approval before any code runs.
              </p>

              <div className="mx-auto flex max-w-3xl flex-col gap-4">
                <ActiveJobBanner />

                {startError && (
                  <div>
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

                {issue.status === "ok" && (
                  <>
                    {issue.data.issue.state !== "open" && (
                      <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-300">
                        Only open issues can be run.
                      </p>
                    )}

                    <article className="rounded-xl border border-zinc-200/80 bg-white p-5 shadow-xs dark:border-zinc-800/80 dark:bg-zinc-900/60">
                      <div className="mb-3 flex items-center gap-2.5">
                        <span
                          aria-hidden
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold uppercase text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                        >
                          {(issue.data.issue.author ?? "?").slice(0, 1)}
                        </span>
                        <div className="min-w-0 text-xs">
                          <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                            {issue.data.issue.author ?? "Unknown author"}
                          </span>
                          <span className="ml-2 text-zinc-400">
                            <time dateTime={issue.data.issue.updatedAt}>{relativeTime(issue.data.issue.updatedAt)}</time>
                          </span>
                        </div>
                      </div>

                      {/* Rendered with GitHub Flavored Markdown; raw HTML is disabled. */}
                      {issue.data.issue.body.trim() ? (
                        <Markdown content={issue.data.issue.body} />
                      ) : (
                        <p className="text-sm italic text-zinc-400">No description provided.</p>
                      )}
                    </article>
                  </>
                )}
              </div>
            </div>

            {/* Calm bottom action bar */}
            {issue.status === "ok" && (
              <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-zinc-200/80 bg-white px-6 py-3 dark:border-zinc-800/80 dark:bg-zinc-950">
                <p className="text-xs text-zinc-500">
                  Shipfig drafts a plan for your approval before making any edits or opening a draft PR.
                </p>
                <Button onClick={run} disabled={!issueReady || starting}>
                  {starting ? "Starting…" : "Run Shipfig"}
                </Button>
              </footer>
            )}
          </>
        )}
      </section>
    </div>
  );
}
