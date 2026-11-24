"use client";

import Link from "next/link";
import { STATE_LABELS } from "@/lib/jobs/states";
import type { Job } from "@/lib/jobs/store";
import { useResource } from "./api";
import { ErrorNotice, Loading, Muted, Panel } from "./ui";

/** Recent jobs, newest first, including failed and canceled ones. */
export function JobsList() {
  const jobs = useResource<{ jobs: Job[]; activeJobId: string | null }>("/api/jobs");
  if (jobs.status === "loading" || jobs.status === "idle") return <Loading label="Loading jobs" />;
  if (jobs.status === "error") return <ErrorNotice message={jobs.error.message} onRetry={jobs.reload} />;
  const list = jobs.data.jobs;
  return (
    <Panel title={`Jobs (${list.length})`}>
      {list.length === 0 ? (
        <Muted>No jobs yet. Pick an issue to start one.</Muted>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="py-1 pr-4 font-medium">Job</th>
                <th className="py-1 pr-4 font-medium">Issue</th>
                <th className="py-1 pr-4 font-medium">State</th>
                <th className="py-1 pr-4 font-medium">Created</th>
                <th className="py-1 font-medium">Pull request</th>
              </tr>
            </thead>
            <tbody>
              {list.map((job) => (
                <tr key={job.id} className="border-t border-zinc-100 align-top dark:border-zinc-900">
                  <td className="py-1.5 pr-4 font-mono text-xs">
                    <Link href={`/jobs/${job.id}`} className="underline underline-offset-2">
                      {job.id}
                    </Link>
                    {job.id === jobs.data.activeJobId && <span className="ml-1 text-sky-700 dark:text-sky-300">active</span>}
                  </td>
                  <td className="py-1.5 pr-4">
                    {job.repoOwner}/{job.repoName}#{job.issueNumber} <span className="text-zinc-500">{job.issueTitle}</span>
                  </td>
                  <td className="py-1.5 pr-4">
                    {STATE_LABELS[job.state]}
                    {job.failureReason ? ` (${job.failureReason.replace(/_/g, " ")})` : ""}
                    {job.cancelReason ? ` (${job.cancelReason.replace(/_/g, " ")})` : ""}
                  </td>
                  <td className="py-1.5 pr-4 text-xs">
                    <time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString()}</time>
                  </td>
                  <td className="py-1.5 text-xs">
                    {job.prUrl ? (
                      <a href={job.prUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                        #{job.publishResult?.prNumber ?? "PR"}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
