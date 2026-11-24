"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { AWAITING_HUMAN_STATES, STATE_LABELS, isTerminal } from "@/lib/jobs/states";
import type { Job } from "@/lib/jobs/store";
import { useResource } from "./api";
import { type BadgeTone, EmptyState, ErrorNotice, Loading, StatusBadge } from "./ui";

type JobFilter = "all" | "active" | "waiting" | "completed" | "failed";

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
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Recent jobs, newest first, with quick status filters and calm, scannable rows. */
export function JobsList() {
  const jobs = useResource<{ jobs: Job[]; activeJobId: string | null }>("/api/jobs");
  const [filter, setFilter] = useState<JobFilter>("all");

  const counts = useMemo(() => {
    const list = jobs.status === "ok" ? jobs.data.jobs : [];
    return {
      all: list.length,
      active: list.filter((j) => !isTerminal(j.state)).length,
      waiting: list.filter((j) => AWAITING_HUMAN_STATES.has(j.state)).length,
      completed: list.filter((j) => j.state === "completed").length,
      failed: list.filter((j) => j.state === "failed" || j.state === "canceled").length,
    };
  }, [jobs]);

  const filtered = useMemo(() => {
    if (jobs.status !== "ok") return [];
    const list = jobs.data.jobs;
    switch (filter) {
      case "active":
        return list.filter((j) => !isTerminal(j.state));
      case "waiting":
        return list.filter((j) => AWAITING_HUMAN_STATES.has(j.state));
      case "completed":
        return list.filter((j) => j.state === "completed");
      case "failed":
        return list.filter((j) => j.state === "failed" || j.state === "canceled");
      default:
        return list;
    }
  }, [jobs, filter]);

  if (jobs.status === "loading" || jobs.status === "idle") return <Loading label="Loading jobs" />;
  if (jobs.status === "error") return <ErrorNotice message={jobs.error.message} onRetry={jobs.reload} />;

  const list = jobs.data.jobs;

  const tabs: { key: JobFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "active", label: "Active" },
    { key: "waiting", label: "Needs approval" },
    { key: "completed", label: "Completed" },
    { key: "failed", label: "Failed / Canceled" },
  ];

  return (
    <section className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white dark:border-zinc-800/80 dark:bg-zinc-950">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200/80 px-3 py-2 dark:border-zinc-800/80">
        <div role="tablist" aria-label="Filter jobs" className="flex flex-wrap items-center gap-1">
          {tabs.map((tab) => {
            const active = filter === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(tab.key)}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  active
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
                }`}
              >
                <span>{tab.label}</span>
                <span className={`text-[11px] ${active ? "opacity-75" : "text-zinc-400"}`}>{counts[tab.key]}</span>
              </button>
            );
          })}
        </div>
        <Link
          href="/"
          className="inline-flex h-7 items-center rounded-md border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-900 transition-colors hover:bg-zinc-50 dark:border-zinc-700/80 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
        >
          + New job
        </Link>
      </header>

      {list.length === 0 ? (
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
      ) : filtered.length === 0 ? (
        <EmptyState title="No jobs in this view" description="Try another filter to see your other runs." />
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
          {filtered.map((job) => {
            const isActive = job.id === jobs.data.activeJobId;
            return (
              <li
                key={job.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 text-sm transition-colors hover:bg-zinc-50/80 dark:hover:bg-zinc-900/50"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/jobs/${job.id}`}
                      className="truncate font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                    >
                      {job.issueTitle}
                    </Link>
                    {isActive && (
                      <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-300">
                        Active
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
                    <span>
                      {job.repoOwner}/{job.repoName} #{job.issueNumber}
                    </span>
                    <span aria-hidden>·</span>
                    <time dateTime={job.createdAt} title={new Date(job.createdAt).toLocaleString()}>
                      {relativeTime(job.createdAt)}
                    </time>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2.5">
                  {job.prUrl && (
                    <a
                      href={job.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
                    >
                      PR #{job.publishResult?.prNumber ?? ""} ↗
                    </a>
                  )}
                  <StatusBadge tone={badgeTone(job)}>{STATE_LABELS[job.state]}</StatusBadge>
                  <Link
                    href={`/jobs/${job.id}`}
                    aria-label={`Open job for ${job.issueTitle}`}
                    className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                  >
                    →
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
