"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AWAITING_HUMAN_STATES, STATE_LABELS, isTerminal } from "@/lib/jobs/states";
import type { Job, JobEvent } from "@/lib/jobs/store";
import { jobTimeline } from "@/lib/jobs/timeline";
import { fetchJson } from "./api";
import { EventLog } from "./event-log";
import { ChecksView, DiffView, ExecutorAttempts, ReviewView } from "./evidence-view";
import { JobTimeline } from "./job-timeline";
import { PlanView } from "./plan-view";
import { PublishView } from "./publish-view";
import { Button, ErrorNotice, Loading, Panel } from "./ui";

/** Poll quickly while Shipfig is working, slowly while it waits for a human, and not at all in a hidden tab. */
const POLL_WORKING_MS = 2_000;
const POLL_WAITING_MS = 6_000;
const SPRITE_POLL_MS = 15_000;

const STATE_TONE: Record<string, string> = {
  completed: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  failed: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
  canceled: "bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200",
  waiting: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  working: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
};

function stateTone(job: Job) {
  if (job.state === "completed" || job.state === "failed" || job.state === "canceled") return STATE_TONE[job.state];
  return AWAITING_HUMAN_STATES.has(job.state) ? STATE_TONE.waiting : STATE_TONE.working;
}

function useSpriteStatus(id: string, active: boolean) {
  const [sprite, setSprite] = useState<{ name: string | null; status: string; checkedAt: string } | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function check() {
      try {
        const data = await fetchJson<{ name: string | null; status: string; checkedAt: string }>(`/api/jobs/${id}/sprite`);
        if (!stopped) setSprite(data);
      } catch {
        // Status is informational; keep the last value.
      }
      if (!stopped && active) timer = setTimeout(check, SPRITE_POLL_MS);
    }
    check();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id, active]);
  return sprite;
}

/**
 * Job dashboard: issue → plan → patch → checks → diff → publish → PR, with a
 * timeline built from recorded transitions, the real command results, the
 * exact diff, and state-aware approve/reject actions.
 */
export function JobStatus({ id }: { id: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let lastEventId = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let first = true;

    async function poll() {
      if (document.visibilityState === "hidden") {
        timer = setTimeout(poll, POLL_WAITING_MS);
        return;
      }
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
        if (!isTerminal(data.job.state)) timer = setTimeout(poll, AWAITING_HUMAN_STATES.has(data.job.state) ? POLL_WAITING_MS : POLL_WORKING_MS);
      } catch (e) {
        if (stopped) return;
        setError((e as Error).message);
        timer = setTimeout(poll, POLL_WAITING_MS);
      }
    }
    const onVisible = () => {
      if (document.visibilityState === "visible" && !stopped) {
        clearTimeout(timer);
        poll();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [id, refresh]);

  const active = job ? !isTerminal(job.state) : true;
  useEffect(() => {
    if (!active) return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [active]);
  const sprite = useSpriteStatus(id, active);
  const steps = useMemo(() => (job ? jobTimeline(job, events) : []), [job, events]);

  async function post(path: string, body?: unknown) {
    setBusy(true);
    try {
      await fetchJson(`/api/jobs/${id}${path}`, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
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

      <section aria-labelledby="job-title" className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-zinc-500">
              <a href={job.issueUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                {job.repoOwner}/{job.repoName}#{job.issueNumber}
              </a>{" "}
              · job <span className="font-mono">{job.id}</span>
            </p>
            <h1 id="job-title" className="mt-0.5 break-words text-lg font-semibold">
              {job.issueTitle}
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span aria-live="polite" className={`rounded-full px-2.5 py-1 text-xs font-medium ${stateTone(job)}`}>
              {STATE_LABELS[job.state]}
              {job.failureReason ? ` · ${job.failureReason.replace(/_/g, " ")}` : ""}
              {job.cancelReason ? ` · ${job.cancelReason.replace(/_/g, " ")}` : ""}
            </span>
            {job.prUrl && (
              <a href={job.prUrl} target="_blank" rel="noopener noreferrer" className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700">
                View PR #{job.publishResult?.prNumber ?? ""}
              </a>
            )}
            {canRetry && (
              <Button variant="secondary" onClick={() => post("/retry")} disabled={busy}>
                {resumesPublish ? "Retry publish" : "Retry"}
              </Button>
            )}
            {canCancel && (
              <Button variant="danger" onClick={() => post("/cancel")} disabled={busy}>
                Cancel
              </Button>
            )}
          </div>
        </div>

        <div className="mt-4">
          <JobTimeline steps={steps} now={now} />
        </div>

        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-1 border-t border-zinc-100 pt-3 text-xs sm:grid-cols-[auto_1fr] dark:border-zinc-900">
          <dt className="text-zinc-500">Created</dt>
          <dd>
            <time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString()}</time> · attempt {job.attempt} · repairs {job.retryCount}
            {job.finishedAt && (
              <>
                {" "}
                · finished <time dateTime={job.finishedAt}>{new Date(job.finishedAt).toLocaleString()}</time>
              </>
            )}
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
              <dd className="font-mono">
                {job.branchName} from {job.baseBranch}@
                <a href={`https://github.com/${job.repoOwner}/${job.repoName}/commit/${job.baseSha}`} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                  {job.baseSha.slice(0, 12)}
                </a>
                {job.checkpointId ? ` · checkpoint ${job.checkpointId}` : ""}
              </dd>
            </>
          )}
          <dt className="text-zinc-500">Sprite</dt>
          <dd>
            <span className="font-mono">{job.spriteName ?? "—"}</span>
            {sprite && (
              <>
                {" "}
                · <span className={sprite.status === "deleted" ? "text-zinc-500" : "font-medium"}>{sprite.status}</span>
                <span className="text-zinc-500"> (checked {new Date(sprite.checkedAt).toLocaleTimeString()})</span>
              </>
            )}
          </dd>
          {job.error && (
            <>
              <dt className="text-zinc-500">Error</dt>
              <dd className="min-w-0 text-red-700 [overflow-wrap:anywhere] dark:text-red-300">{job.error}</dd>
            </>
          )}
        </dl>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          {job.plan ? (
            <PlanView job={job} busy={busy} onDecision={(decision) => post("/plan", { decision, version: job.version })} />
          ) : (
            <Panel title="Plan">
              <p className="text-sm text-zinc-500">{job.state === "planning" ? "The planner is reading the repository…" : "No plan yet."}</p>
            </Panel>
          )}
          <ChecksView job={job} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <PublishView
            job={job}
            busy={busy}
            onDecision={(decision, acknowledgeUnverified) => post("/publish", { decision, version: job.version, diffHash: job.diffHash ?? undefined, acknowledgeUnverified })}
          />
          <ReviewView job={job} />
          <EventLog events={events} />
        </div>
      </div>

      <DiffView job={job} />
      <ExecutorAttempts job={job} />

      <nav className="flex gap-4 text-sm">
        <Link href="/" className="underline underline-offset-2">
          ← Issues
        </Link>
        <Link href="/jobs" className="underline underline-offset-2">
          All jobs
        </Link>
      </nav>
    </div>
  );
}
