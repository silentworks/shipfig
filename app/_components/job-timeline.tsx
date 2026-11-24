"use client";

import type { JobState } from "@/lib/jobs/states";
import { type StepStatus, type TimelineStep, formatDuration } from "@/lib/jobs/timeline";

type SimpleStageStatus = "done" | "current" | "waiting" | "failed" | "upcoming";

interface SimpleStage {
  key: string;
  label: string;
  status: SimpleStageStatus;
}

const STAGE_ORDER: Record<JobState, number> = {
  queued: 0,
  provisioning: 0,
  planning: 0,
  awaiting_plan_approval: 0,
  editing: 1,
  testing: 2,
  awaiting_publish_approval: 3,
  publishing: 3,
  completed: 4,
  failed: -1,
  canceled: -1,
};

function deriveSimpleStages(state: JobState, steps: TimelineStep[]): SimpleStage[] {
  const labels = [
    { key: "plan", label: "Plan" },
    { key: "build", label: "Make changes" },
    { key: "verify", label: "Verify" },
    { key: "publish", label: "Open PR" },
  ];

  if (state === "completed") {
    return labels.map((l) => ({ ...l, status: "done" }));
  }

  // For terminal failure/cancel, infer where the job stopped from recorded steps.
  if (state === "failed" || state === "canceled") {
    const failedIdx = steps.findIndex((s) => s.status === "failed" || s.status === "canceled");
    const stageForStep = (stepIdx: number) => {
      if (stepIdx <= 3) return 0;
      if (stepIdx === 4) return 1;
      if (stepIdx === 5) return 2;
      return 3;
    };
    const stoppedStage = failedIdx === -1 ? 0 : stageForStep(failedIdx);
    return labels.map((l, i) => ({
      ...l,
      status: i < stoppedStage ? "done" : i === stoppedStage ? "failed" : "upcoming",
    }));
  }

  const currentIdx = STAGE_ORDER[state];
  const isWaiting = state === "awaiting_plan_approval" || state === "awaiting_publish_approval";

  return labels.map((l, i) => {
    if (i < currentIdx) return { ...l, status: "done" };
    if (i === currentIdx) return { ...l, status: isWaiting ? "waiting" : "current" };
    return { ...l, status: "upcoming" };
  });
}

const SIMPLE_STYLE: Record<SimpleStageStatus, { dot: string; text: string; symbol: string }> = {
  done: { dot: "border-emerald-500 bg-emerald-500 text-white", text: "text-zinc-900 dark:text-zinc-100", symbol: "✓" },
  current: {
    dot: "border-sky-500 bg-sky-500/15 text-sky-600 dark:text-sky-400 motion-safe:animate-pulse",
    text: "text-zinc-900 dark:text-zinc-100 font-medium",
    symbol: "●",
  },
  waiting: {
    dot: "border-amber-500 bg-amber-500/15 text-amber-700 dark:text-amber-300",
    text: "text-amber-900 dark:text-amber-200 font-medium",
    symbol: "!",
  },
  failed: { dot: "border-red-500 bg-red-500 text-white", text: "text-red-700 dark:text-red-300 font-medium", symbol: "✕" },
  upcoming: { dot: "border-zinc-300 bg-transparent text-zinc-400 dark:border-zinc-700", text: "text-zinc-400 dark:text-zinc-500", symbol: "" },
};

/** Calm 4-stage progress bar shown at the top of the job detail page. */
export function SimpleJobProgress({ state, steps }: { state: JobState; steps: TimelineStep[] }) {
  const stages = deriveSimpleStages(state, steps);
  return (
    <ol aria-label="Job progress" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stages.map((stage, idx) => {
        const style = SIMPLE_STYLE[stage.status];
        const active = stage.status === "current" || stage.status === "waiting";
        return (
          <li key={stage.key} aria-current={active ? "step" : undefined} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold ${style.dot}`}
              >
                {style.symbol}
              </span>
              {idx < stages.length - 1 && (
                <span
                  aria-hidden
                  className={`hidden h-px flex-1 sm:block ${
                    stage.status === "done" ? "bg-emerald-500/50" : "bg-zinc-200 dark:bg-zinc-800"
                  }`}
                />
              )}
            </div>
            <span className={`text-xs ${style.text}`}>{stage.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

const ICON: Record<StepStatus, { symbol: string; tone: string; label: string }> = {
  done: { symbol: "✓", tone: "border-emerald-500 bg-emerald-500 text-white", label: "done" },
  current: {
    symbol: "●",
    tone: "border-sky-500 bg-sky-500/10 text-sky-600 dark:text-sky-400 motion-safe:animate-pulse",
    label: "in progress",
  },
  waiting: {
    symbol: "!",
    tone: "border-amber-500 bg-amber-500/15 text-amber-700 dark:text-amber-300",
    label: "waiting for you",
  },
  failed: { symbol: "✕", tone: "border-red-500 bg-red-500 text-white", label: "failed" },
  canceled: {
    symbol: "–",
    tone: "border-zinc-400 bg-zinc-200 text-zinc-700 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
    label: "canceled",
  },
  upcoming: {
    symbol: "",
    tone: "border-zinc-200 bg-transparent text-zinc-400 dark:border-zinc-800",
    label: "not started",
  },
};

function time(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Detailed 8-step transition timeline (shown inside Technical details). */
export function JobTimeline({ steps, now }: { steps: TimelineStep[]; now: number }) {
  return (
    <ol aria-label="Detailed step timeline" className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
      {steps.map((step) => {
        const icon = ICON[step.status];
        const active = step.status === "current" || step.status === "waiting";
        const duration = step.startedAt ? (step.endedAt ? Date.parse(step.endedAt) : active ? now : null) : null;
        return (
          <li key={step.key} className="flex min-w-0 items-start gap-2">
            <span
              aria-hidden
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px] font-bold ${icon.tone}`}
            >
              {icon.symbol}
            </span>
            <span className="min-w-0 text-xs">
              <span className={`block font-medium ${step.status === "upcoming" ? "text-zinc-400" : "text-zinc-800 dark:text-zinc-200"}`}>
                {step.label}
              </span>
              <span className="sr-only">: {icon.label}</span>
              {step.startedAt && (
                <span className="block font-mono text-[11px] text-zinc-500">
                  <time dateTime={step.startedAt}>{time(step.startedAt)}</time>
                  {duration !== null && ` · ${formatDuration(Math.max(0, duration - Date.parse(step.startedAt)))}`}
                </span>
              )}
              {step.note && <span className="block text-[11px] text-zinc-500">{step.note}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
