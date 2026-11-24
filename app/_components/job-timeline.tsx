"use client";

import { type StepStatus, type TimelineStep, formatDuration } from "@/lib/jobs/timeline";

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

/** Ordered horizontal lifecycle stepper built from recorded state transitions. */
export function JobTimeline({ steps, now }: { steps: TimelineStep[]; now: number }) {
  return (
    <ol aria-label="Job progress" className="grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-4 lg:grid-cols-8">
      {steps.map((step, idx) => {
        const icon = ICON[step.status];
        const active = step.status === "current" || step.status === "waiting";
        const duration = step.startedAt ? (step.endedAt ? Date.parse(step.endedAt) : active ? now : null) : null;
        const connectorDone = step.status === "done";
        return (
          <li key={step.key} aria-current={active ? "step" : undefined} className="relative flex min-w-0 flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold ${icon.tone}`}
              >
                {icon.symbol}
              </span>
              {idx < steps.length - 1 && (
                <span
                  aria-hidden
                  className={`hidden h-px flex-1 lg:block ${
                    connectorDone ? "bg-emerald-500/50" : "bg-zinc-200 dark:bg-zinc-800"
                  }`}
                />
              )}
            </div>
            <div className="min-w-0 text-xs">
              <span
                className={`block truncate font-medium ${
                  step.status === "upcoming"
                    ? "text-zinc-400 dark:text-zinc-600"
                    : active
                      ? "text-zinc-900 dark:text-zinc-100"
                      : "text-zinc-700 dark:text-zinc-300"
                }`}
              >
                {step.label}
              </span>
              <span className="sr-only">: {icon.label}</span>
              {step.startedAt && (
                <span className="block truncate font-mono text-[11px] text-zinc-500">
                  <time dateTime={step.startedAt} title={step.startedAt}>
                    {time(step.startedAt)}
                  </time>
                  {duration !== null && ` · ${formatDuration(Math.max(0, duration - Date.parse(step.startedAt)))}`}
                </span>
              )}
              {step.status === "waiting" && (
                <span className="block text-[11px] font-medium text-amber-700 dark:text-amber-300">Action needed</span>
              )}
              {step.note && <span className="block truncate text-[11px] text-zinc-500">{step.note}</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
