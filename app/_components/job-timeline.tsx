"use client";

import { type StepStatus, type TimelineStep, formatDuration } from "@/lib/jobs/timeline";

const ICON: Record<StepStatus, { symbol: string; tone: string; label: string }> = {
  done: { symbol: "✓", tone: "border-emerald-500 bg-emerald-500 text-white", label: "done" },
  current: { symbol: "●", tone: "border-sky-500 text-sky-600 dark:text-sky-400 motion-safe:animate-pulse", label: "in progress" },
  waiting: { symbol: "!", tone: "border-amber-500 bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200", label: "waiting for you" },
  failed: { symbol: "✕", tone: "border-red-500 bg-red-500 text-white", label: "failed" },
  canceled: { symbol: "–", tone: "border-zinc-400 bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300", label: "canceled" },
  upcoming: { symbol: "", tone: "border-zinc-300 text-zinc-400 dark:border-zinc-700", label: "not started" },
};

function time(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Ordered steps from recorded transitions, with real start times and durations. */
export function JobTimeline({ steps, now }: { steps: TimelineStep[]; now: number }) {
  return (
    <ol aria-label="Job progress" className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 lg:grid-cols-8">
      {steps.map((step) => {
        const icon = ICON[step.status];
        const active = step.status === "current" || step.status === "waiting";
        const duration = step.startedAt ? (step.endedAt ? Date.parse(step.endedAt) : active ? now : null) : null;
        return (
          <li key={step.key} aria-current={active ? "step" : undefined} className="flex min-w-0 items-start gap-2">
            <span aria-hidden className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 text-[11px] font-bold ${icon.tone}`}>
              {icon.symbol}
            </span>
            <span className="min-w-0 text-xs">
              <span className={`block font-medium ${step.status === "upcoming" ? "text-zinc-400" : ""}`}>{step.label}</span>
              <span className="sr-only">: {icon.label}</span>
              {step.startedAt && (
                <span className="block text-zinc-500">
                  <time dateTime={step.startedAt} title={step.startedAt}>
                    {time(step.startedAt)}
                  </time>
                  {duration !== null && ` · ${formatDuration(Math.max(0, duration - Date.parse(step.startedAt)))}`}
                </span>
              )}
              {step.status === "waiting" && <span className="block text-amber-700 dark:text-amber-300">Waiting for you</span>}
              {step.note && <span className="block text-zinc-500">{step.note}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
