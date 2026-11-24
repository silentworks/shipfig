"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { STATE_LABELS, isTerminal } from "@/lib/jobs/states";
import type { Job, JobEvent } from "@/lib/jobs/store";
import { fetchJson } from "./api";
import { EvidenceView } from "./evidence-view";
import { PlanView } from "./plan-view";
import { PublishView } from "./publish-view";
import { Button, ErrorNotice, Loading, Muted, Panel } from "./ui";

const POLL_MS = 2000;

/**
 * Job status view: state, issue reference, plan and publish approvals,
 * evidence, event log, cancel/retry. The full dashboard is SIL-535.
 */
export function JobStatus({ id }: { id: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let lastEventId = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let first = true;

    async function poll() {
      try {
        const data = await fetchJson<{ job: Job; events: JobEvent[] }>(`/api/jobs/${id}?after=${lastEventId}`);
        if (stopped) return;
        setJob(data.job);
        setError(null);
        // The first fetch of this effect run replaces the log (e.g. after cancel/retry); later ones append.
        const replace = first;
        first = false;
        if (data.events.length > 0) lastEventId = data.events[data.events.length - 1].id;
        if (replace || data.events.length > 0) setEvents((prev) => (replace ? data.events : [...prev, ...data.events]));
        if (!isTerminal(data.job.state)) timer = setTimeout(poll, POLL_MS);
      } catch (e) {
        if (stopped) return;
        setError((e as Error).message);
        timer = setTimeout(poll, POLL_MS * 2);
      }
    }
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id, refresh]);

  async function act(action: "cancel" | "retry") {
    setBusy(true);
    try {
      await fetchJson(`/api/jobs/${id}/${action}`, { method: "POST" });
      setRefresh((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function decidePublish(decision: "approve" | "reject", acknowledgeUnverified: boolean) {
    if (!job) return;
    setBusy(true);
    try {
      await fetchJson(`/api/jobs/${id}/publish`, {
        method: "POST",
        body: JSON.stringify({ decision, version: job.version, diffHash: job.diffHash ?? undefined, acknowledgeUnverified }),
      });
      setRefresh((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: "approve" | "reject") {
    if (!job) return;
    setBusy(true);
    try {
      await fetchJson(`/api/jobs/${id}/plan`, { method: "POST", body: JSON.stringify({ decision, version: job.version }) });
      setRefresh((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!job) return error ? <ErrorNotice message={error} /> : <Loading label="Loading job" />;

  const canCancel = !isTerminal(job.state) && job.state !== "publishing";
  const canRetry = job.state === "failed";
  const resumesPublish = canRetry && job.failureReason === "publish_error" && job.hasPublishBundle;

  return (
    <div className="flex flex-col gap-4">
      {error && <ErrorNotice message={error} />}
      <Panel
        title={`Job ${job.id}`}
        actions={
          <div className="flex gap-2">
            {canRetry && (
              <Button variant="secondary" onClick={() => act("retry")} disabled={busy}>
                {resumesPublish ? "Retry publish" : "Retry"}
              </Button>
            )}
            {canCancel && (
              <Button variant="danger" onClick={() => act("cancel")} disabled={busy}>
                Cancel
              </Button>
            )}
          </div>
        }
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-zinc-500">State</dt>
          <dd aria-live="polite" className="font-medium">
            {STATE_LABELS[job.state]}
            {job.failureReason ? ` (${job.failureReason})` : ""}
            {job.cancelReason ? ` (${job.cancelReason})` : ""}
          </dd>
          <dt className="text-zinc-500">Issue</dt>
          <dd>
            <a href={job.issueUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              {job.repoOwner}/{job.repoName}#{job.issueNumber}
            </a>{" "}
            {job.issueTitle}
          </dd>
          <dt className="text-zinc-500">Attempt</dt>
          <dd>
            {job.attempt} · repairs {job.retryCount}
          </dd>
          <dt className="text-zinc-500">Created</dt>
          <dd>
            <time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString()}</time>
          </dd>
          {job.deadlineAt && (
            <>
              <dt className="text-zinc-500">Times out</dt>
              <dd>
                <time dateTime={job.deadlineAt}>{new Date(job.deadlineAt).toLocaleString()}</time>
              </dd>
            </>
          )}
          {job.baseSha && (
            <>
              <dt className="text-zinc-500">Workspace</dt>
              <dd className="font-mono text-xs leading-6">
                {job.branchName} from {job.baseBranch}@
                <a
                  href={`https://github.com/${job.repoOwner}/${job.repoName}/commit/${job.baseSha}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2"
                >
                  {job.baseSha.slice(0, 12)}
                </a>
                <br />
                sprite {job.spriteName}
                {job.checkpointId ? ` · checkpoint ${job.checkpointId}` : ""}
                {job.workspace ? ` · ${job.workspace.packageManager === "npm" ? "npm" : "no package.json"}` : ""}
              </dd>
            </>
          )}
          {job.prUrl && (
            <>
              <dt className="text-zinc-500">Pull request</dt>
              <dd>
                <a href={job.prUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                  {job.prUrl}
                </a>
              </dd>
            </>
          )}
          {job.error && (
            <>
              <dt className="text-zinc-500">Error</dt>
              <dd className="break-words text-red-700 dark:text-red-300">{job.error}</dd>
            </>
          )}
        </dl>

      </Panel>
      <PlanView job={job} busy={busy} onDecision={decide} />
      <EvidenceView job={job} />
      <PublishView job={job} busy={busy} onDecision={decidePublish} />
      <Panel title="Events">
        {events.length === 0 ? (
          <Muted>No events yet.</Muted>
        ) : (
          <ol className="flex flex-col gap-2 font-mono text-xs">
            {events.map((e) => (
              <li key={e.id} className="flex gap-3">
                <time dateTime={e.at} className="shrink-0 text-zinc-500">
                  {new Date(e.at).toLocaleTimeString()}
                </time>
                <span className={e.kind === "error" ? "text-red-700 dark:text-red-300" : ""}>{e.message}</span>
              </li>
            ))}
          </ol>
        )}
      </Panel>
      <Link href="/" className="text-sm underline underline-offset-2">
        ← Back to issues
      </Link>
    </div>
  );
}
