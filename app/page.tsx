import { Suspense } from "react";
import { ActiveJobBanner } from "@/app/_components/active-job-banner";
import { IssuePicker } from "@/app/_components/issue-picker";
import { Loading } from "@/app/_components/ui";

const WORKFLOW_STEPS = [
  { n: "1", label: "Pick issue" },
  { n: "2", label: "Approve plan" },
  { n: "3", label: "Verify in Sprite" },
  { n: "4", label: "Approve draft PR" },
];

export default function Home() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <ActiveJobBanner />

      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">Pick an issue</h1>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
            Select a GitHub issue to plan, verify in an isolated Sprite, and open a draft pull request.
          </p>
        </div>

        <ol aria-label="How Shipfig works" className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
          {WORKFLOW_STEPS.map((step, i) => (
            <li key={step.n} className="flex items-center gap-1.5">
              <span className="inline-flex items-center gap-1 rounded-full border border-zinc-200/80 bg-white px-2 py-0.5 dark:border-zinc-800 dark:bg-zinc-950">
                <span className="font-mono text-[10px] font-semibold text-zinc-400">{step.n}</span>
                <span>{step.label}</span>
              </span>
              {i < WORKFLOW_STEPS.length - 1 && (
                <span aria-hidden className="text-zinc-300 dark:text-zinc-700">
                  →
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>

      <Suspense fallback={<Loading label="Loading issues" />}>
        <IssuePicker />
      </Suspense>
    </div>
  );
}
