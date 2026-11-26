"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { STATE_LABELS } from "@/lib/jobs/states";
import type { Job } from "@/lib/jobs/store";
import { fetchJson } from "./api";
import { StatusBadge } from "./ui";

const POLL_MS = 5000;
const NEEDS_YOU = new Set<Job["state"]>(["awaiting_plan_approval", "awaiting_publish_approval"]);

/**
 * Shows the one active job (Shipfig runs one at a time) with a direct link to
 * its page, so a job in progress or awaiting approval is always one click away.
 */
export function ActiveJobBanner({ onActiveChange }: { onActiveChange?: (hasActiveJob: boolean) => void } = {}) {
  const [job, setJob] = useState<Job | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const data = await fetchJson<{ jobs: Job[]; activeJobId: string | null; queuedJobIds?: string[] }>("/api/jobs");
        if (stopped) return;
        const active = data.jobs.find((j) => j.id === data.activeJobId) ?? null;
        setJob(active);
        setQueuedCount(data.queuedJobIds?.length ?? 0);
        onActiveChange?.(active !== null);
      } catch {
        // The banner is a convenience: keep the last known state and try again.
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    }
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [onActiveChange]);

  if (!job) return null;
  const needsYou = NEEDS_YOU.has(job.state);

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-sm ${
        needsYou
          ? "border-amber-500/35 bg-amber-500/10 text-amber-950 dark:text-amber-100"
          : "border-zinc-200/80 bg-white text-zinc-900 dark:border-zinc-800/80 dark:bg-zinc-950 dark:text-zinc-100"
      }`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2.5">
        <StatusBadge tone={needsYou ? "waiting" : "working"}>
          {needsYou ? "Needs your approval" : STATE_LABELS[job.state]}
        </StatusBadge>
        <p className="min-w-0 truncate text-xs sm:text-sm">
          <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
            {job.repoOwner}/{job.repoName}#{job.issueNumber}
          </span>{" "}
          <span className="font-medium">{job.issueTitle}</span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {queuedCount > 0 && (
          <Link
            href="/jobs"
            className="rounded-md border border-zinc-200/80 bg-zinc-50 px-2 py-1 text-[11px] font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700/80 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            +{queuedCount} queued
          </Link>
        )}
        <Link
          href={`/jobs/${job.id}`}
          className={`shrink-0 rounded-md px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 ${
            needsYou
              ? "bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-500 dark:text-zinc-950 dark:hover:bg-amber-400"
              : "border border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
          }`}
        >
          {needsYou ? "Review now →" : "Open job →"}
        </Link>
      </div>
    </div>
  );
}
