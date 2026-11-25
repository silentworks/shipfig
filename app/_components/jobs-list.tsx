"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AWAITING_HUMAN_STATES, STATE_LABELS, isTerminal } from "@/lib/jobs/states";
import type { Job } from "@/lib/jobs/store";
import { fetchJson } from "./api";
import { type BadgeTone, EmptyState, ErrorNotice, Loading, StatusBadge } from "./ui";

type JobFilter = "all" | "active" | "waiting" | "completed" | "failed";
const POLL_MS = 5_000;

function badgeTone(job: Job): BadgeTone {
  if (job.state === "completed" || job.state === "failed" || job.state === "canceled") return job.state;
  return AWAITING_HUMAN_STATES.has(job.state) ? "waiting" : "working";
}

function relativeTime(iso: string): string {
  const diffSec = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (Number.isNaN(diffSec) || diffSec < 60) return "just now";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Middle column jobs list aligned with the Issues 3-pane hierarchy. */
export function JobsList() {
  const pathname = usePathname();
  const selectedJobId = pathname.startsWith("/jobs/") ? pathname.slice("/jobs/".length) : null;

  const [data, setData] = useState<{ jobs: Job[]; activeJobId: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<JobFilter>("all");
  const [query, setQuery] = useState("");
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      if (document.visibilityState === "hidden") {
        timer = setTimeout(poll, POLL_MS);
        return;
      }
      try {
        const res = await fetchJson<{ jobs: Job[]; activeJobId: string | null }>("/api/jobs");
        if (!stopped) {
          setData(res);
          setError(null);
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    }

    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [reloadNonce]);

  const counts = useMemo(() => {
    const list = data?.jobs ?? [];
    return {
      all: list.length,
      active: list.filter((j) => !isTerminal(j.state)).length,
      waiting: list.filter((j) => AWAITING_HUMAN_STATES.has(j.state)).length,
      completed: list.filter((j) => j.state === "completed").length,
      failed: list.filter((j) => j.state === "failed" || j.state === "canceled").length,
    };
  }, [data]);

  const filtered = useMemo(() => {
    const list = data?.jobs ?? [];
    const byStatus = list.filter((j) => {
      switch (filter) {
        case "active":
          return !isTerminal(j.state);
        case "waiting":
          return AWAITING_HUMAN_STATES.has(j.state);
        case "completed":
          return j.state === "completed";
        case "failed":
          return j.state === "failed" || j.state === "canceled";
        default:
          return true;
      }
    });
    const q = query.trim().toLowerCase();
    if (!q) return byStatus;
    return byStatus.filter(
      (j) =>
        j.issueTitle.toLowerCase().includes(q) ||
        `${j.repoOwner}/${j.repoName}`.toLowerCase().includes(q) ||
        String(j.issueNumber).includes(q) ||
        STATE_LABELS[j.state].toLowerCase().includes(q),
    );
  }, [data, filter, query]);

  const tabs: { key: JobFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "active", label: "Active" },
    { key: "waiting", label: "Approval" },
    { key: "completed", label: "Done" },
    { key: "failed", label: "Failed" },
  ];

  // On mobile, hide the list when viewing a specific job detail so the detail fills the screen.
  const visibilityClass = selectedJobId ? "hidden md:flex" : "flex";

  return (
    <section
      aria-label="Jobs list"
      className={`${visibilityClass} min-h-0 w-full shrink-0 flex-col border-b border-zinc-200/80 bg-white md:w-80 md:border-b-0 md:border-r lg:w-[22rem] dark:border-zinc-800/80 dark:bg-zinc-950`}
    >
      {/* Top search bar */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-200/80 px-3.5 dark:border-zinc-800/80">
        <svg aria-hidden viewBox="0 0 16 16" fill="none" className="h-4 w-4 shrink-0 text-zinc-400">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5L13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search jobs"
          aria-label="Search jobs"
          className="w-full bg-transparent text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-100"
        />
        {data && <span className="shrink-0 text-xs text-zinc-400">{filtered.length}</span>}
      </div>

      {/* Compact filter strip */}
      <div
        role="tablist"
        aria-label="Filter jobs"
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-zinc-200/80 px-2.5 py-2 dark:border-zinc-800/80"
      >
        {tabs.map((tab) => {
          const active = filter === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setFilter(tab.key)}
              className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                active
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
              }`}
            >
              <span>{tab.label}</span>
              <span className={active ? "opacity-75" : "text-zinc-400"}>{counts[tab.key]}</span>
            </button>
          );
        })}
      </div>

      {/* Scrollable job cards */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!data && !error && (
          <div className="p-4">
            <Loading label="Loading jobs" />
          </div>
        )}
        {error && !data && (
          <div className="p-4">
            <ErrorNotice message={error} onRetry={() => setReloadNonce((n) => n + 1)} />
          </div>
        )}
        {data && data.jobs.length === 0 && (
          <EmptyState
            title="No jobs yet"
            description="Pick an open GitHub issue to start your first Shipfig run."
            action={
              <Link
                href="/"
                className="inline-flex h-8 items-center rounded-md bg-zinc-900 px-3.5 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                Pick an issue
              </Link>
            }
          />
        )}
        {data && data.jobs.length > 0 && filtered.length === 0 && (
          <EmptyState title="No matching jobs" description="Try another filter or search term." />
        )}

        {data && filtered.length > 0 && (
          <ul className="flex flex-col divide-y divide-zinc-200/70 dark:divide-zinc-800/70">
            {filtered.map((job) => {
              const selected = job.id === selectedJobId;
              const isActive = job.id === data.activeJobId;
              return (
                <li key={job.id}>
                  <Link
                    href={`/jobs/${job.id}`}
                    aria-current={selected ? "page" : undefined}
                    className={`relative block px-4 py-3.5 transition-colors ${
                      selected
                        ? "bg-sky-50/80 dark:bg-sky-950/35"
                        : "hover:bg-zinc-50/80 dark:hover:bg-zinc-900/50"
                    }`}
                  >
                    {selected && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-sky-500" />}

                    {/* Row 1: #issue · repo + relative time */}
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className={`truncate ${selected ? "text-sky-700 dark:text-sky-300" : "text-zinc-500"}`}>
                        <span
                          className={`font-semibold ${selected ? "text-sky-700 dark:text-sky-300" : "text-zinc-700 dark:text-zinc-300"}`}
                        >
                          #{job.issueNumber}
                        </span>
                        {" · "}
                        <span>{job.repoName}</span>
                      </span>
                      <time
                        dateTime={job.createdAt}
                        title={new Date(job.createdAt).toLocaleString()}
                        className={`shrink-0 text-[11px] ${selected ? "text-sky-600 dark:text-sky-400" : "text-zinc-400"}`}
                      >
                        {relativeTime(job.createdAt)}
                      </time>
                    </div>

                    {/* Row 2: Issue title */}
                    <p
                      className={`mt-1 line-clamp-2 text-sm font-semibold leading-snug ${
                        selected ? "text-sky-700 dark:text-sky-200" : "text-zinc-900 dark:text-zinc-100"
                      }`}
                    >
                      {job.issueTitle}
                    </p>

                    {/* Row 3: Status badge + PR badge */}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <StatusBadge tone={badgeTone(job)}>{STATE_LABELS[job.state]}</StatusBadge>
                      {isActive && (
                        <span className="rounded border border-sky-200/80 bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:border-sky-800/60 dark:bg-sky-950/60 dark:text-sky-300">
                          Active
                        </span>
                      )}
                      {job.prUrl && (
                        <span className="rounded border border-emerald-200/80 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/60 dark:text-emerald-300">
                          PR #{job.publishResult?.prNumber ?? ""}
                        </span>
                      )}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
