"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AWAITING_HUMAN_STATES, STATE_LABELS, isTerminal } from "@/lib/jobs/states";
import type { Job } from "@/lib/jobs/store";
import { fetchJson } from "./api";
import { type BadgeTone, StatusBadge } from "./ui";

const POLL_MS = 5_000;

interface IssueJobsResponse {
  jobs: Job[];
  activeJobId: string | null;
  queuedJobIds?: string[];
}

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

/**
 * Displays all Shipfig jobs created against the currently selected GitHub issue,
 * with direct links into each job's detail page.
 */
export function IssueJobsList({ repo, issueNumber }: { repo: string; issueNumber: number }) {
  const [data, setData] = useState<IssueJobsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const [owner, name] = repo.split("/");
    if (!owner || !name) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const params = new URLSearchParams({
      owner,
      repo: name,
      issueNumber: String(issueNumber),
    });

    async function load() {
      if (document.visibilityState === "hidden") {
        timer = setTimeout(load, POLL_MS);
        return;
      }
      try {
        const res = await fetchJson<IssueJobsResponse>(`/api/jobs?${params.toString()}`);
        if (stopped) return;
        setData(res);
        setError(null);
        const hasLiveJob = res.jobs.some((j) => !isTerminal(j.state));
        if (hasLiveJob) {
          timer = setTimeout(load, POLL_MS);
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
    }

    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [repo, issueNumber]);

  const jobs = data?.jobs ?? [];

  return (
    <section
      aria-label="Jobs for this issue"
      className="rounded-xl border border-zinc-200/80 bg-white shadow-xs dark:border-zinc-800/80 dark:bg-zinc-900/60"
    >
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200/70 px-5 py-3 dark:border-zinc-800/70">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Jobs</h2>
          {data && (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              {jobs.length}
            </span>
          )}
        </div>
        {jobs.length > 0 && (
          <Link
            href="/jobs"
            className="text-xs text-zinc-500 hover:text-zinc-900 hover:underline dark:hover:text-zinc-100"
          >
            All jobs →
          </Link>
        )}
      </div>

      {error && (
        <p className="px-5 py-3 text-xs text-red-600 dark:text-red-400">Could not load jobs: {error}</p>
      )}

      {!data && !error && (
        <p className="px-5 py-3.5 text-xs text-zinc-400">Loading jobs…</p>
      )}

      {data && jobs.length === 0 && (
        <p className="px-5 py-3.5 text-xs text-zinc-500 dark:text-zinc-400">
          No jobs have been created for this issue yet.
        </p>
      )}

      {data && jobs.length > 0 && (
        <ul className="divide-y divide-zinc-200/70 dark:divide-zinc-800/70">
          {jobs.map((job) => {
            const isActive = job.id === data.activeJobId;
            const queueIdx = data.queuedJobIds?.indexOf(job.id) ?? -1;
            const queuePosition = queueIdx >= 0 ? queueIdx + 1 : null;
            const reason = job.failureReason ?? job.cancelReason;

            return (
              <li key={job.id}>
                <Link
                  href={`/jobs/${job.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <StatusBadge tone={badgeTone(job)}>
                      {STATE_LABELS[job.state]}
                      {reason ? ` · ${reason.replace(/_/g, " ")}` : ""}
                    </StatusBadge>
                    {isActive && (
                      <span className="rounded border border-sky-200/80 bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:border-sky-800/60 dark:bg-sky-950/60 dark:text-sky-300">
                        Active
                      </span>
                    )}
                    {queuePosition !== null && (
                      <span className="rounded border border-amber-200/80 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/60 dark:text-amber-300">
                        Queue #{queuePosition}
                      </span>
                    )}
                    {job.prUrl && (
                      <span className="rounded border border-emerald-200/80 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/60 dark:text-emerald-300">
                        PR #{job.publishResult?.prNumber ?? ""}
                      </span>
                    )}
                    <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                      {job.id}
                      {job.attempt > 1 ? ` · attempt ${job.attempt}` : ""}
                    </span>
                  </div>

                  <div className="flex shrink-0 items-center gap-2 text-xs text-zinc-400">
                    <time dateTime={job.createdAt} title={new Date(job.createdAt).toLocaleString()}>
                      {relativeTime(job.createdAt)}
                    </time>
                    <span aria-hidden className="text-zinc-400">
                      →
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
