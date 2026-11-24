"use client";

import { useState } from "react";
import type { Job } from "@/lib/jobs/store";
import { Button, Panel, StatusBadge } from "./ui";

/**
 * Publish approval and result. Approval sends the diff hash the user is
 * looking at; the server only accepts it if it matches the recorded diff.
 */
export function PublishView({
  job,
  busy,
  onDecision,
}: {
  job: Job;
  busy: boolean;
  onDecision(decision: "approve" | "reject", acknowledgeUnverified: boolean): void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const result = job.publishResult;
  const awaiting = job.state === "awaiting_publish_approval";
  const unverified = job.verification?.outcome === "unverified";

  if (!awaiting && job.state !== "publishing" && !result && !job.publishApprovedAt) return null;

  return (
    <Panel
      title="Pull request"
      className={awaiting ? "ring-1 ring-amber-500/35" : ""}
      actions={
        awaiting ? (
          <StatusBadge tone="waiting">Ready for your approval</StatusBadge>
        ) : result ? (
          <StatusBadge tone="completed">PR #{result.prNumber}</StatusBadge>
        ) : job.state === "publishing" ? (
          <StatusBadge tone="working">Opening PR</StatusBadge>
        ) : null
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        {result ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-emerald-950 dark:text-emerald-100">
            <div>
              <p className="font-semibold">
                {result.reused.pullRequest ? "Pull request ready" : result.draft ? "Draft pull request opened" : "Pull request opened"}
              </p>
              <p className="mt-0.5 text-xs opacity-85">
                Shipfig never merges automatically. Review the PR on GitHub and mark it ready when you&apos;re happy.
              </p>
              {result.baseMoved && (
                <p className="mt-1 text-xs font-medium">The base branch moved after this job started — check the PR for conflicts.</p>
              )}
            </div>
            <a
              href={result.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 shrink-0 items-center rounded-md bg-emerald-600 px-3.5 text-xs font-medium text-white hover:bg-emerald-700"
            >
              Open PR #{result.prNumber} on GitHub ↗
            </a>
          </div>
        ) : job.state === "publishing" ? (
          <p role="status" className="text-zinc-600 dark:text-zinc-400">
            Opening your draft pull request on GitHub…
          </p>
        ) : awaiting ? (
          <>
            <p className="text-sm text-zinc-700 dark:text-zinc-300">
              Review the verification results and code changes below. When you approve, Shipfig will open a draft pull request on{" "}
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                {job.repoOwner}/{job.repoName}
              </span>
              . Nothing is merged automatically.
            </p>
            {unverified && (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-amber-500/35 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />
                <span>I understand some checks could not run, so this change is unverified.</span>
              </label>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={() => onDecision("reject", false)} disabled={busy}>
                Reject
              </Button>
              <Button onClick={() => onDecision("approve", acknowledged)} disabled={busy || !job.diffHash || (unverified && !acknowledged)}>
                Approve &amp; open draft PR
              </Button>
            </div>
          </>
        ) : null}
        {job.publishApprovedAt && (
          <p className="text-xs text-zinc-500">
            Approved by {job.publishApprovedBy} on <time dateTime={job.publishApprovedAt}>{new Date(job.publishApprovedAt).toLocaleString()}</time>
          </p>
        )}
      </div>
    </Panel>
  );
}
