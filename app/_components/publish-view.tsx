"use client";

import { useState } from "react";
import type { Job } from "@/lib/jobs/store";
import { Button, Panel } from "./ui";

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
            <Button variant="secondary" onClick={() => onDecision("reject", false)} disabled={busy}>
              Reject
            </Button>
            <Button onClick={() => onDecision("approve", acknowledged)} disabled={busy || !job.diffHash || (unverified && !acknowledged)}>
              Approve and open draft PR
            </Button>
          </div>
        ) : null
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        {result ? (
          <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
            <p className="font-semibold">
              {result.reused.pullRequest ? "Pull request" : result.draft ? "Draft pull request opened" : "Pull request opened"}:{" "}
              <a href={result.prUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                #{result.prNumber}
              </a>
            </p>
            <p className="mt-1 font-mono text-xs">
              {result.branch} @ {result.commitSha.slice(0, 12)} · {result.prState}
              {result.reused.commit || result.reused.pullRequest ? " · reused from an earlier attempt" : ""}
            </p>
            {result.baseMoved && <p className="mt-1">The base branch moved after this job started; check the PR for conflicts.</p>}
            <p className="mt-1">Shipfig never merges. Review the PR on GitHub and mark it ready when you are happy.</p>
          </div>
        ) : job.state === "publishing" ? (
          <p role="status">Publishing the approved change to GitHub…</p>
        ) : awaiting ? (
          <>
            <p>
              Approving creates branch <code className="font-mono text-xs">{job.branchName}</code> with exactly the diff above and opens a draft pull request for{" "}
              {job.repoOwner}/{job.repoName}#{job.issueNumber}. Nothing is merged.
            </p>
            {unverified && (
              <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                <input type="checkbox" className="mt-0.5" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                <span>I understand some requested checks could not run, so this change is unverified. The PR will say so.</span>
              </label>
            )}
          </>
        ) : null}
        {job.publishApprovedAt && (
          <p className="text-xs text-zinc-500">
            Approved by {job.publishApprovedBy} at <time dateTime={job.publishApprovedAt}>{new Date(job.publishApprovedAt).toLocaleString()}</time> for diff{" "}
            <span className="font-mono">{job.publishApprovedHash?.slice(0, 12)}</span>
          </p>
        )}
      </div>
    </Panel>
  );
}
