"use client";

import type { Job, TestResult } from "@/lib/jobs/store";
import type { VerificationOutcome } from "@/lib/verify/evidence";
import { type BadgeTone, CollapsiblePanel, Muted, Panel, StatusBadge } from "./ui";

const OUTCOME: Record<VerificationOutcome, { label: string; badge: BadgeTone; detail: string }> = {
  verified: {
    label: "All checks passed",
    badge: "completed",
    detail: "Every verification check ran and passed.",
  },
  unverified: {
    label: "Partially verified",
    badge: "waiting",
    detail: "Nothing failed, but some checks were not available to run.",
  },
  failed: {
    label: "Checks failed",
    badge: "failed",
    detail: "One or more checks did not pass.",
  },
};

const RESULT_BADGE: Record<TestResult["status"], { label: string; tone: BadgeTone }> = {
  passed: { label: "Passed", tone: "completed" },
  failed: { label: "Failed", tone: "failed" },
  timed_out: { label: "Timed out", tone: "failed" },
  not_run: { label: "Not run", tone: "waiting" },
};

function friendlyCheckName(command: string[]): string {
  // Turn `npm run typecheck` into `typecheck`, `npm test` into `test`.
  if (command[0] === "npm" && command[1] === "run" && command[2]) return command.slice(2).join(" ");
  if (command[0] === "npm" && command[1]) return command.slice(1).join(" ");
  return command.join(" ");
}

function ChecksList({ results }: { results: TestResult[] }) {
  if (results.length === 0) return null;
  return (
    <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200/80 dark:divide-zinc-900 dark:border-zinc-800/80">
      {results.map((r, i) => {
        const failed = r.status === "failed" || r.status === "timed_out";
        const badge = RESULT_BADGE[r.status];
        return (
          <li key={i} className="px-3.5 py-2.5 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="font-medium capitalize text-zinc-900 dark:text-zinc-100">{friendlyCheckName(r.command)}</span>
                {r.durationMs !== null && <span className="text-xs text-zinc-400">{(r.durationMs / 1000).toFixed(1)}s</span>}
              </div>
              <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
            </div>
            {r.summary && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{r.summary}</p>}
            {r.output && (
              <details className="mt-1.5 text-xs" open={failed}>
                <summary className="cursor-pointer text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
                  {failed ? "Show failure output" : "Show output"}
                </summary>
                <pre className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-200/80 bg-zinc-50 p-2.5 font-mono text-[11px] dark:border-zinc-800 dark:bg-zinc-900">
                  {r.output}
                </pre>
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index ")) {
    return "text-zinc-400 dark:text-zinc-500";
  }
  if (line.startsWith("@@")) return "bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (line.startsWith("+")) return "bg-emerald-500/10 text-emerald-900 dark:text-emerald-200";
  if (line.startsWith("-")) return "bg-red-500/10 text-red-900 dark:text-red-200";
  return "";
}

/** Human-readable verification summary with expandable outputs and baseline checks. */
export function ChecksView({ job }: { job: Job }) {
  const v = job.verification;
  const outcome = v ? OUTCOME[v.outcome] : null;
  const baselineFailed = job.baselineResults.some((r) => r.status === "failed" || r.status === "timed_out");

  return (
    <Panel title="Verification" actions={outcome ? <StatusBadge tone={outcome.badge}>{outcome.label}</StatusBadge> : undefined}>
      {!v && job.testResults.length === 0 && job.baselineResults.length === 0 ? (
        <Muted>
          {job.state === "editing" || job.state === "testing" ? "Running checks on the changes…" : "No checks have run yet."}
        </Muted>
      ) : (
        <div className="flex flex-col gap-3">
          {outcome && <p className="text-sm text-zinc-600 dark:text-zinc-400">{outcome.detail}</p>}
          <ChecksList results={job.testResults} />
          {v && v.flags.length > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
              <p className="font-medium">Notes</p>
              <ul className="mt-1 list-disc space-y-1 pl-4">
                {v.flags.map((f, i) => (
                  <li key={i} className="break-words">
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {job.baselineResults.length > 0 && (
            <details open={baselineFailed} className="text-xs">
              <summary className="cursor-pointer text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
                Before-change baseline ({job.baselineResults.length} checks)
              </summary>
              <div className="mt-2">
                <ChecksList results={job.baselineResults} />
              </div>
            </details>
          )}
        </div>
      )}
    </Panel>
  );
}

/** Model review of the real diff: can block, never approves. */
export function ReviewView({ job }: { job: Job }) {
  const v = job.verification;
  if (!v || (!v.review && !v.reviewError)) return null;

  const isPass = v.review?.verdict === "pass" && v.review.concerns.length === 0;
  const badge = v.review ? (
    <StatusBadge tone={v.review.verdict === "pass" ? "completed" : "failed"}>
      {v.review.verdict === "pass" ? "Looks good" : "Needs attention"}
    </StatusBadge>
  ) : (
    <StatusBadge tone="waiting">Unavailable</StatusBadge>
  );

  return (
    <CollapsiblePanel
      title="Automated review"
      badge={badge}
      summary={v.review ? (v.review.concerns.length === 0 ? "No concerns" : `${v.review.concerns.length} concern(s)`) : v.reviewError ?? undefined}
      defaultOpen={!isPass}
    >
      <div className="flex flex-col gap-2.5 text-sm">
        <p className="text-xs text-zinc-500">
          Automated review of the diff and check results. It can flag issues, while final approval is always yours.
        </p>
        {v.review ? (
          <>
            {v.review.concerns.length > 0 ? (
              <ul className="list-disc space-y-1 pl-4 text-xs text-zinc-800 dark:text-zinc-200">
                {v.review.concerns.map((c, i) => (
                  <li key={i} className="break-words">
                    {c}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-zinc-600 dark:text-zinc-400">No concerns raised.</p>
            )}
            {v.review.evidence.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
                  Cited evidence ({v.review.evidence.length})
                </summary>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-zinc-600 dark:text-zinc-400">
                  {v.review.evidence.map((e, i) => (
                    <li key={i} className="break-words">
                      {e}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        ) : (
          <p className="text-xs text-amber-800 dark:text-amber-300">Review unavailable: {v.reviewError}</p>
        )}
      </div>
    </CollapsiblePanel>
  );
}

/** Clean file summary + unified diff viewer. */
export function DiffView({ job }: { job: Job }) {
  const v = job.verification;
  if (!job.diff) return null;

  return (
    <Panel
      title="Code changes"
      actions={
        v ? (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-zinc-500">
              {v.diff.files.length} {v.diff.files.length === 1 ? "file" : "files"}
            </span>
            <span className="font-mono text-emerald-600 dark:text-emerald-400">+{v.diff.additions}</span>
            <span className="font-mono text-red-600 dark:text-red-400">−{v.diff.deletions}</span>
          </div>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        {v && v.diff.files.length > 0 && (
          <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200/80 text-xs dark:divide-zinc-900 dark:border-zinc-800/80">
            {v.diff.files.map((f) => (
              <li key={f.path} className="flex items-center justify-between gap-3 px-3 py-1.5">
                <span className="min-w-0 truncate font-mono text-zinc-800 dark:text-zinc-200">{f.path}</span>
                <span className="shrink-0 font-mono text-[11px]">
                  {f.additions === null ? (
                    <span className="text-zinc-500">binary</span>
                  ) : (
                    <>
                      <span className="text-emerald-600 dark:text-emerald-400">+{f.additions}</span>{" "}
                      <span className="text-red-600 dark:text-red-400">−{f.deletions}</span>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        <pre
          tabIndex={0}
          aria-label="Unified diff"
          className="max-h-[34rem] overflow-auto rounded-lg border border-zinc-200/80 bg-zinc-50/70 font-mono text-xs leading-5 dark:border-zinc-800/80 dark:bg-zinc-950"
        >
          {job.diff.split("\n").map((line, i) => (
            <div key={i} className={`whitespace-pre px-3 ${lineClass(line)}`}>
              {line || " "}
            </div>
          ))}
        </pre>
        {v?.diff.truncated && <p className="text-xs text-zinc-500">Diff truncated for display.</p>}
      </div>
    </Panel>
  );
}

/** The executor's own reports: shown inside Technical details. */
export function ExecutorAttempts({ job }: { job: Job }) {
  if (job.execution.length === 0) return null;
  return (
    <CollapsiblePanel
      title="Agent attempts"
      summary={`${job.execution.length} ${job.execution.length === 1 ? "attempt" : "attempts"}`}
      defaultOpen={false}
    >
      <ol className="flex flex-col gap-2">
        {job.execution.map((a) => {
          const report = a.report as { summary?: string } | null;
          return (
            <li key={a.attempt} className="rounded-md border border-zinc-200/80 bg-zinc-50/70 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900/50">
              <p className="font-medium text-zinc-900 dark:text-zinc-100">{a.attempt === 0 ? "First attempt" : `Repair ${a.attempt}`}</p>
              {report?.summary && <p className="mt-1 whitespace-pre-wrap break-words text-zinc-700 dark:text-zinc-300">{report.summary}</p>}
              <p className="mt-1.5 font-mono text-[11px] text-zinc-500">
                wrote {a.filesWritten.join(", ") || "nothing"}
                {a.refusals.length > 0 ? ` · refused: ${a.refusals.join("; ")}` : ""} · {a.usage.turns} turns
              </p>
            </li>
          );
        })}
      </ol>
    </CollapsiblePanel>
  );
}
