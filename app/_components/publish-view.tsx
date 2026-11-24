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
      title="Publish"
      actions={
        awaiting ? (
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => onDecision("reject", false)} disabled={busy}>
              Reject
            </Button>
            <Button
              size="sm"
              onClick={() => onDecision("approve", acknowledged)}
              disabled={busy || !job.diffHash || (unverified && !acknowledged)}
            >
              Approve &amp; open draft PR
            </Button>
          </div>
        ) : result ? (
          <StatusBadge tone="completed">PR #{result.prNumber}</StatusBadge>
        ) : job.state === "publishing" ? (
          <StatusBadge tone="working">Publishing</StatusBadge>
        ) : null
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        {result ? (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3.5 text-emerald-950 dark:text-emerald-100">
            <p className="font-semibold">
              {result.reused.pullRequest ? "Pull request" : result.draft ? "Draft pull request opened" : "Pull request opened"}:{" "}
              <a href={result.prUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                #{result.prNumber} ↗
              </a>
            </p>
            <p className="mt-1 font-mono text-xs opacity-80">
              {result.branch} @ {result.commitSha.slice(0, 12)} · {result.prState}
              {result.reused.commit || result.reused.pullRequest ? " · reused from earlier attempt" : ""}
            </p>
            {result.baseMoved && (
              <p className="mt-1.5 text-xs">The base branch moved after this job started; check the PR for conflicts.</p>
            )}
            <p className="mt-1.5 text-xs opacity-85">
              Shipfig never merges. Review the PR on GitHub and mark it ready when you are happy.
            </p>
          </div>
        ) : job.state === "publishing" ? (
          <p role="status" className="text-zinc-600 dark:text-zinc-400">
            Publishing the approved change to GitHub…
          </p>
        ) : awaiting ? (
          <>
            <p className="text-sm text-zinc-700 dark:text-zinc-300">
              Approving creates branch <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-900">{job.branchName}</code> with
              the exact diff shown below and opens a draft pull request for{" "}
              <span className="font-mono text-xs">
                {job.repoOwner}/{job.repoName}#{job.issueNumber}
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
                <span>I understand some requested checks could not run, so this change is unverified. The PR will say so.</span>
              </label>
            )}
          </>
        ) : null}
        {job.publishApprovedAt && (
          <p className="text-[11px] text-zinc-500">
            Approved by {job.publishApprovedBy} at <time dateTime={job.publishApprovedAt}>{new Date(job.publishApprovedAt).toLocaleString()}</time> for diff{" "}
            <span className="font-mono">{job.publishApprovedHash?.slice(0, 12)}</span>
          </p>
        )}
      </div>
    </Panel>
  );
}
