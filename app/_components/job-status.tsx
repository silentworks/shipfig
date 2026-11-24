"use client";

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
import { type BadgeTone, Button, ErrorNotice, Loading, Panel, StatusBadge } from "./ui";

/** Poll quickly while Shipfig is working, slowly while it waits for a human, and not at all in a hidden tab. */
const POLL_WORKING_MS = 2_000;
const POLL_WAITING_MS = 6_000;
const SPRITE_POLL_MS = 15_000;

function stateTone(job: Job): BadgeTone {
  if (job.state === "completed" || job.state === "failed" || job.state === "canceled") return job.state;
  return AWAITING_HUMAN_STATES.has(job.state) ? "waiting" : "working";
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
 * Job dashboard: guides the human through issue → plan → checks → diff → PR
 * with a clear header, sticky next-action callout, and progressive disclosure.
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
        const replace = first;
        first = false;
        if (data.events.length > 0) lastEventId = data.events[data.events.length - 1].id;
        if (replace || data.events.length > 0) setEvents((prev) => (replace ? data.events : [...prev, ...data.events]));
        if (!isTerminal(data.job.state)) {
          timer = setTimeout(poll, AWAITING_HUMAN_STATES.has(data.job.state) ? POLL_WAITING_MS : POLL_WORKING_MS);
        }
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
  const awaitingPlan = job.state === "awaiting_plan_approval";
  const awaitingPublish = job.state === "awaiting_publish_approval";
  const inReviewOrDone = awaitingPublish || job.state === "publishing" || job.state === "completed";
  const terminalDefaultOpen = (!isTerminal(job.state) && !AWAITING_HUMAN_STATES.has(job.state)) || job.state === "failed";
  const reason = job.failureReason ?? job.cancelReason;

  return (
    <div className="flex flex-col gap-5">
      {error && <ErrorNotice message={error} />}

      {/* Job header + lifecycle stepper */}
      <section
        aria-labelledby="job-title"
        className="rounded-lg border border-zinc-200/80 bg-white p-5 dark:border-zinc-800/80 dark:bg-zinc-950"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <a
                href={job.issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono hover:text-zinc-900 hover:underline dark:hover:text-zinc-100"
              >
                {job.repoOwner}/{job.repoName}#{job.issueNumber} ↗
              </a>
              <span aria-hidden>·</span>
              <span className="font-mono">{job.id}</span>
            </div>
            <h1 id="job-title" className="mt-1 break-words text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              {job.issueTitle}
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={stateTone(job)}>
              {STATE_LABELS[job.state]}
              {reason ? ` · ${reason.replace(/_/g, " ")}` : ""}
            </StatusBadge>
            {job.prUrl && (
              <a
                href={job.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-8 items-center rounded-md bg-emerald-600 px-3 text-xs font-medium text-white transition-colors hover:bg-emerald-700"
              >
                View PR #{job.publishResult?.prNumber ?? ""} ↗
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

        <div className="mt-5 border-t border-zinc-100 pt-4 dark:border-zinc-900">
          <JobTimeline steps={steps} now={now} />
        </div>

        {/* Compact inline metadata strip */}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-zinc-100 pt-3 text-xs text-zinc-500 dark:border-zinc-900">
          <span>
            Created <time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString()}</time>
          </span>
          {job.baseSha && (
            <span className="font-mono">
              {job.branchName} ← {job.baseBranch}@
              <a
                href={`https://github.com/${job.repoOwner}/${job.repoName}/commit/${job.baseSha}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-zinc-900 dark:hover:text-zinc-200"
              >
                {job.baseSha.slice(0, 8)}
              </a>
            </span>
          )}
          <span className="font-mono">
            sprite: {job.spriteName ?? "—"}
            {sprite ? ` (${sprite.status})` : ""}
          </span>
          <span>
            attempt {job.attempt} · repairs {job.retryCount}
          </span>
          {job.deadlineAt && (
            <span>
              times out <time dateTime={job.deadlineAt}>{new Date(job.deadlineAt).toLocaleTimeString()}</time>
            </span>
          )}
        </div>

        {job.error && (
          <div
            role="alert"
            className="mt-3 rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-800 [overflow-wrap:anywhere] dark:text-red-200"
          >
            <span className="font-semibold">Error: </span>
            {job.error}
          </div>
        )}
      </section>

      {/* Above-the-fold action callout when Shipfig is waiting on the human */}
      {awaitingPlan && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          <div className="min-w-0">
            <p className="font-medium text-amber-950 dark:text-amber-100">Plan ready for your approval</p>
            <p className="text-xs text-amber-900/80 dark:text-amber-200/80">
              Review the proposed files and checks below before Shipfig edits any code.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="secondary" onClick={() => post("/plan", { decision: "reject", version: job.version })} disabled={busy}>
              Reject
            </Button>
            <Button onClick={() => post("/plan", { decision: "approve", version: job.version })} disabled={busy}>
              Approve plan
            </Button>
          </div>
        </div>
      )}

      {awaitingPublish && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          <div className="min-w-0">
            <p className="font-medium text-amber-950 dark:text-amber-100">Changes verified — ready to open a draft PR</p>
            <p className="text-xs text-amber-900/80 dark:text-amber-200/80">
              Inspect the diff and check results below, then approve in the Publish section to open a draft pull request.
            </p>
          </div>
          <a
            href="#publish-section"
            className="inline-flex h-8 shrink-0 items-center rounded-md bg-amber-600 px-3.5 text-xs font-medium text-white hover:bg-amber-700 dark:bg-amber-500 dark:text-zinc-950 dark:hover:bg-amber-400"
          >
            Review &amp; publish ↓
          </a>
        </div>
      )}

      {/* Primary content: ordered by what matters most in the current lifecycle stage */}
      {inReviewOrDone ? (
        <>
          <div id="publish-section">
            <PublishView
              job={job}
              busy={busy}
              onDecision={(decision, acknowledgeUnverified) =>
                post("/publish", { decision, version: job.version, diffHash: job.diffHash ?? undefined, acknowledgeUnverified })
              }
            />
          </div>
          <DiffView job={job} />
          <ChecksView job={job} />
          <ReviewView job={job} />
          {job.plan && (
            <PlanView
              job={job}
              busy={busy}
              collapsible
              onDecision={(decision) => post("/plan", { decision, version: job.version })}
            />
          )}
        </>
      ) : (
        <>
          {job.plan ? (
            <PlanView job={job} busy={busy} onDecision={(decision) => post("/plan", { decision, version: job.version })} />
          ) : (
            <Panel title="Plan">
              <p className="text-xs text-zinc-500">
                {job.state === "planning"
                  ? "The planner is reading the repository and drafting a plan…"
                  : job.state === "provisioning" || job.state === "queued"
                    ? "Preparing isolated Sprite workspace before planning…"
                    : "No plan was generated."}
              </p>
            </Panel>
          )}
          <ChecksView job={job} />
          <DiffView job={job} />
          <ReviewView job={job} />
        </>
      )}

      {/* Secondary / diagnostic details collapsed by default when idle or awaiting human */}
      <EventLog events={events} defaultOpen={terminalDefaultOpen} />
      <ExecutorAttempts job={job} />
    </div>
  );
}
