"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { STATE_LABELS } from "@/lib/jobs/states";
import type { Job } from "@/lib/jobs/store";
import { fetchJson } from "./api";

const POLL_MS = 5000;
const NEEDS_YOU = new Set<Job["state"]>(["awaiting_plan_approval", "awaiting_publish_approval"]);

/**
 * Shows the one active job (Shipfig runs one at a time) with a link to its
 * page, so a job in progress is never more than one click from the home page.
 */
export function ActiveJobBanner() {
  const [job, setJob] = useState<Job | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const data = await fetchJson<{ jobs: Job[]; activeJobId: string | null }>("/api/jobs");
        if (stopped) return;
        setJob(data.jobs.find((j) => j.id === data.activeJobId) ?? null);
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
  }, []);

  if (!job) return null;
  const needsYou = NEEDS_YOU.has(job.state);

  return (
    <div
      role="status"
      aria-live="polite"
      className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm ${
        needsYou
          ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          : "border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
      }`}
    >
      <p className="min-w-0 break-words">
        <span className="font-semibold">{needsYou ? "Job needs your approval" : "Job in progress"}</span>
        {" · "}
        {STATE_LABELS[job.state]}
        {" · "}
        {job.repoOwner}/{job.repoName}#{job.issueNumber} {job.issueTitle}
      </p>
      <Link
        href={`/jobs/${job.id}`}
        className="shrink-0 rounded-md px-3 py-1.5 font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500"
      >
        View job
      </Link>
    </div>
  );
}
