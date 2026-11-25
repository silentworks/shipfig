"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AWAITING_HUMAN_STATES, type JobState, STATE_LABELS, isTerminal } from "@/lib/jobs/states";
import type { Job, JobEvent } from "@/lib/jobs/store";
import { jobTimeline } from "@/lib/jobs/timeline";
import { fetchJson } from "./api";
import { EventLog } from "./event-log";
import { ChecksView, DiffView, ExecutorAttempts, ReviewView } from "./evidence-view";
import { JobTimeline, SimpleJobProgress } from "./job-timeline";
import { PlanView } from "./plan-view";
import { PublishView } from "./publish-view";
import { type BadgeTone, Button, CollapsiblePanel, ErrorNotice, Loading, Panel, StatusBadge } from "./ui";

const POLL_WORKING_MS = 2_000;
const POLL_WAITING_MS = 6_000;
const SPRITE_POLL_MS = 15_000;

const STATUS_SUMMARY: Record<JobState, string> = {
  queued: "Queued and waiting to start.",
  provisioning: "Setting up an isolated workspace for this repository…",
  planning: "Reading the repository and drafting a step-by-step plan…",
  awaiting_plan_approval: "Review the plan below and approve it so Shipfig can begin making changes.",
  editing: "Applying the approved plan in an isolated workspace…",
  testing: "Running checks to verify the changes…",
  awaiting_publish_approval: "Changes are ready. Review the checks and diff below, then approve to open a draft PR.",
  publishing: "Opening a draft pull request on GitHub…",
  completed: "Draft pull request opened. Review it on GitHub when you're ready.",
  failed: "This run stopped with an error. You can review what happened or retry.",
  canceled: "This run was canceled before completion.",
};

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
        // Informational only.
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
 * Right-pane job detail canvas aligned with the Issue Detail view:
 * sticky white header with status + 4-stage progress, scrollable body canvas
 * with calm cards, and a single collapsed Technical details drawer.
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

  if (!job) {
    return (
      <div className="p-6">
        {error ? <ErrorNotice message={error} /> : <Loading label="Loading job" />}
      </div>
    );
  }

  const canCancel = !isTerminal(job.state) && job.state !== "publishing";
  const canRetry = job.state === "failed";
  const resumesPublish = canRetry && job.failureReason === "publish_error" && job.hasPublishBundle;
  const awaitingPlan = job.state === "awaiting_plan_approval";
  const awaitingPublish = job.state === "awaiting_publish_approval";
  const inReviewOrDone = awaitingPublish || job.state === "publishing" || job.state === "completed";
  const reviewFlagged = Boolean(job.verification?.reviewError || (job.verification?.review && job.verification.review.verdict !== "pass"));
  const reason = job.failureReason ?? job.cancelReason;

  return (
    <div className="flex min-h-0 flex-1 flex-col md:overflow-hidden">
      {/* Top white header — mirrors Issue Detail header */}
      <header
        aria-labelledby="job-title"
        className="shrink-0 border-b border-zinc-200/80 bg-white px-6 py-4 dark:border-zinc-800/80 dark:bg-zinc-950"
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Link
                href="/jobs"
                className="text-zinc-500 hover:text-zinc-900 md:hidden dark:hover:text-zinc-100"
              >
                ← Jobs
              </Link>
              <StatusBadge tone={stateTone(job)}>
                {STATE_LABELS[job.state]}
                {reason ? ` · ${reason.replace(/_/g, " ")}` : ""}
              </StatusBadge>
              <a
                href={job.issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-zinc-500 hover:text-zinc-900 hover:underline dark:hover:text-zinc-100"
              >
                {job.repoOwner}/{job.repoName} #{job.issueNumber} ↗
              </a>
            </div>

            <div className="flex flex-wrap items-center gap-2">
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
                <Button variant="ghost" onClick={() => post("/cancel")} disabled={busy}>
                  Cancel
                </Button>
              )}
            </div>
          </div>

          <div>
            <h1 id="job-title" className="break-words text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              {job.issueTitle}
            </h1>
            <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">{STATUS_SUMMARY[job.state]}</p>
          </div>

          <div className="pt-1">
            <SimpleJobProgress state={job.state} steps={steps} />
          </div>
        </div>
      </header>

      {/* Scrollable body canvas */}
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {error && <ErrorNotice message={error} />}

          {job.error && (
            <div
              role="alert"
              className="rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-800 [overflow-wrap:anywhere] dark:text-red-200"
            >
              <span className="font-medium">Error: </span>
              {job.error}
            </div>
          )}

          {inReviewOrDone ? (
            <>
              <PublishView
                job={job}
                busy={busy}
                onDecision={(decision, acknowledgeUnverified) =>
                  post("/publish", { decision, version: job.version, diffHash: job.diffHash ?? undefined, acknowledgeUnverified })
                }
              />
              <ChecksView job={job} />
              {reviewFlagged && <ReviewView job={job} />}
              <DiffView job={job} />
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
                <PlanView
                  job={job}
                  busy={busy}
                  highlightApproval={awaitingPlan}
                  onDecision={(decision) => post("/plan", { decision, version: job.version })}
                />
              ) : (
                <Panel title="Plan">
                  <p className="text-sm text-zinc-500">
                    {job.state === "planning"
                      ? "Reading the repository and drafting a plan…"
                      : job.state === "provisioning" || job.state === "queued"
                        ? "Preparing an isolated workspace before drafting the plan…"
                        : "No plan was generated for this run."}
                  </p>
                </Panel>
              )}
              {(job.verification || job.testResults.length > 0 || job.state === "editing" || job.state === "testing") && (
                <ChecksView job={job} />
              )}
              {reviewFlagged && <ReviewView job={job} />}
              <DiffView job={job} />
            </>
          )}

          {/* Single collapsible drawer for all technical/ops metadata and logs */}
          <CollapsiblePanel
            title="Technical details"
            summary="Run metadata, step timings, and activity log"
            defaultOpen={job.state === "failed"}
          >
            <div className="flex flex-col gap-5">
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-[9rem_1fr]">
                <dt className="text-zinc-500">Job ID</dt>
                <dd className="font-mono text-zinc-800 dark:text-zinc-200">{job.id}</dd>

                <dt className="text-zinc-500">Created</dt>
                <dd className="text-zinc-800 dark:text-zinc-200">
                  <time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString()}</time>
                </dd>

                <dt className="text-zinc-500">Attempts</dt>
                <dd className="text-zinc-800 dark:text-zinc-200">
                  Attempt {job.attempt} · {job.retryCount} automated {job.retryCount === 1 ? "repair" : "repairs"}
                </dd>

                {job.baseSha && (
                  <>
                    <dt className="text-zinc-500">Branch &amp; base</dt>
                    <dd className="font-mono text-zinc-800 dark:text-zinc-200">
                      {job.branchName} from {job.baseBranch}@
                      <a
                        href={`https://github.com/${job.repoOwner}/${job.repoName}/commit/${job.baseSha}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline underline-offset-2"
                      >
                        {job.baseSha.slice(0, 12)}
                      </a>
                      {job.checkpointId ? ` · checkpoint ${job.checkpointId}` : ""}
                    </dd>
                  </>
                )}

                <dt className="text-zinc-500">Workspace Sprite</dt>
                <dd className="font-mono text-zinc-800 dark:text-zinc-200">
                  {job.spriteName ?? "—"}
                  {sprite ? ` · ${sprite.status}` : ""}
                </dd>

                {job.deadlineAt && (
                  <>
                    <dt className="text-zinc-500">Timeout</dt>
                    <dd className="text-zinc-800 dark:text-zinc-200">
                      <time dateTime={job.deadlineAt}>{new Date(job.deadlineAt).toLocaleString()}</time>
                    </dd>
                  </>
                )}

                {job.finishedAt && (
                  <>
                    <dt className="text-zinc-500">Finished</dt>
                    <dd className="text-zinc-800 dark:text-zinc-200">
                      <time dateTime={job.finishedAt}>{new Date(job.finishedAt).toLocaleString()}</time>
                    </dd>
                  </>
                )}
              </dl>

              <div className="border-t border-zinc-100 pt-4 dark:border-zinc-900">
                <h3 className="mb-3 text-xs font-medium text-zinc-500">Step timings</h3>
                <JobTimeline steps={steps} now={now} />
              </div>

              {!reviewFlagged && <ReviewView job={job} />}
              <EventLog events={events} defaultOpen={job.state === "failed"} />
              <ExecutorAttempts job={job} />
            </div>
          </CollapsiblePanel>
        </div>
      </div>
    </div>
  );
}
