"use client";

import type { Job, TestResult } from "@/lib/jobs/store";
import type { VerificationOutcome } from "@/lib/verify/evidence";
import { type BadgeTone, CollapsiblePanel, Muted, Panel, StatusBadge } from "./ui";

const OUTCOME: Record<VerificationOutcome, { label: string; badge: BadgeTone; tone: string; detail: string }> = {
  verified: {
    label: "Verified",
    badge: "completed",
    tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200",
    detail: "Every requested check ran and exited 0.",
  },
  unverified: {
    label: "Unverified",
    badge: "waiting",
    tone: "border-amber-500/35 bg-amber-500/10 text-amber-900 dark:text-amber-200",
    detail: "Nothing failed, but some requested checks could not run. Missing checks are not passing checks.",
  },
  failed: {
    label: "Checks failed",
    badge: "failed",
    tone: "border-red-500/30 bg-red-500/10 text-red-900 dark:text-red-200",
    detail: "At least one check did not exit 0.",
  },
};

const STATUS: Record<TestResult["status"], string> = {
  passed: "text-emerald-700 dark:text-emerald-300",
  failed: "text-red-700 dark:text-red-300",
  timed_out: "text-red-700 dark:text-red-300",
  not_run: "text-amber-700 dark:text-amber-300",
};

function ResultsTable({ results, caption }: { results: TestResult[]; caption?: string }) {
  if (results.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        {caption && (
          <caption className="mb-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            {caption}
          </caption>
        )}
        <thead className="text-[11px] text-zinc-500">
          <tr>
            <th className="py-1 pr-4 font-medium">Command</th>
            <th className="py-1 pr-4 font-medium">Result</th>
            <th className="py-1 pr-4 font-medium">Exit</th>
            <th className="py-1 pr-4 font-medium">Time</th>
            <th className="py-1 font-medium">Summary</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r, i) => {
            const failed = r.status === "failed" || r.status === "timed_out";
            return (
              <tr key={i} className="border-t border-zinc-100 align-top dark:border-zinc-900">
                <td className="py-2 pr-4 font-mono text-xs text-zinc-900 dark:text-zinc-100">{r.command.join(" ")}</td>
                <td className={`py-2 pr-4 text-xs font-medium ${STATUS[r.status]}`}>{r.status.replace("_", " ")}</td>
                <td className="py-2 pr-4 font-mono text-xs text-zinc-500">{r.exitCode ?? "—"}</td>
                <td className="py-2 pr-4 font-mono text-xs text-zinc-500">
                  {r.durationMs === null ? "—" : `${(r.durationMs / 1000).toFixed(1)}s`}
                </td>
                <td className="py-2 text-xs text-zinc-700 dark:text-zinc-300">
                  {r.summary ?? ""}
                  {r.output && (
                    <details className="mt-1" open={failed}>
                      <summary className="cursor-pointer text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
                        {failed ? "Failure output" : "Output"}
                      </summary>
                      <pre className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-200/80 bg-zinc-50 p-2.5 font-mono text-[11px] dark:border-zinc-800 dark:bg-zinc-900">
                        {r.output}
                      </pre>
                    </details>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index ")) {
    return "text-zinc-500";
  }
  if (line.startsWith("@@")) return "bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (line.startsWith("+")) return "bg-emerald-500/10 text-emerald-900 dark:text-emerald-200";
  if (line.startsWith("-")) return "bg-red-500/10 text-red-900 dark:text-red-200";
  return "";
}

/** Checks: outcome, real results after the change, collapsible baseline, and server flags. */
export function ChecksView({ job }: { job: Job }) {
  const v = job.verification;
  const outcome = v ? OUTCOME[v.outcome] : null;
  const baselineFailed = job.baselineResults.some((r) => r.status === "failed" || r.status === "timed_out");

  return (
    <Panel title="Checks" actions={outcome ? <StatusBadge tone={outcome.badge}>{outcome.label}</StatusBadge> : undefined}>
      {!v && job.testResults.length === 0 && job.baselineResults.length === 0 ? (
        <Muted className="text-xs">
          {job.state === "editing" || job.state === "testing" ? "Running checks in isolated Sprite…" : "No checks have run yet."}
        </Muted>
      ) : (
        <div className="flex flex-col gap-4">
          {outcome && (
            <div className={`rounded-lg border px-3 py-2.5 text-xs ${outcome.tone}`}>
              <p className="font-semibold">{outcome.label}</p>
              <p className="mt-0.5 opacity-90">{outcome.detail}</p>
            </div>
          )}
          <ResultsTable results={job.testResults} caption="After change" />
          {job.baselineResults.length > 0 && (
            <details open={baselineFailed} className="rounded-md border border-zinc-200/80 px-3 py-2 dark:border-zinc-800/80">
              <summary className="cursor-pointer text-xs font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
                Baseline checks before change ({job.baselineResults.length})
              </summary>
              <div className="mt-2.5">
                <ResultsTable results={job.baselineResults} />
              </div>
            </details>
          )}
          {v && v.flags.length > 0 && (
            <div>
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Flags</h3>
              <ul className="list-disc space-y-1 pl-4 text-xs text-amber-800 dark:text-amber-300">
                {v.flags.map((f, i) => (
                  <li key={i} className="break-words">
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

/** Model review of the real diff: can block, never approves. Auto-collapsed when clean pass. */
export function ReviewView({ job }: { job: Job }) {
  const v = job.verification;
  if (!v || (!v.review && !v.reviewError)) return null;

  const isPass = v.review?.verdict === "pass" && v.review.concerns.length === 0;
  const badge = v.review ? (
    <StatusBadge tone={v.review.verdict === "pass" ? "completed" : "failed"}>Verdict: {v.review.verdict}</StatusBadge>
  ) : (
    <StatusBadge tone="waiting">Unavailable</StatusBadge>
  );

  return (
    <CollapsiblePanel
      title="Automated Review"
      badge={badge}
      summary={v.review ? (v.review.concerns.length === 0 ? "No concerns" : `${v.review.concerns.length} concern(s)`) : v.reviewError ?? undefined}
      defaultOpen={!isPass}
    >
      <div className="flex flex-col gap-2.5 text-sm">
        <p className="text-xs text-zinc-500">
          Model review of the actual diff and check results. It can block a change but never approves one.
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

/** The exact diff the human reviews, with per-file stats and its sha256. */
export function DiffView({ job }: { job: Job }) {
  const v = job.verification;
  if (!job.diff) return null;

  return (
    <Panel
      title="Diff"
      actions={
        v ? (
          <div className="flex items-center gap-2 font-mono text-xs">
            <span className="text-zinc-500">
              {v.diff.files.length} {v.diff.files.length === 1 ? "file" : "files"}
            </span>
            <span className="text-emerald-600 dark:text-emerald-400">+{v.diff.additions}</span>
            <span className="text-red-600 dark:text-red-400">−{v.diff.deletions}</span>
          </div>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        {v && v.diff.files.length > 0 && (
          <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200/80 font-mono text-xs dark:divide-zinc-900 dark:border-zinc-800/80">
            {v.diff.files.map((f) => (
              <li key={f.path} className="flex items-center justify-between gap-3 px-3 py-1.5">
                <span className="min-w-0 truncate">
                  <span className="mr-2 inline-block w-16 text-[11px] text-zinc-400">{f.status}</span>
                  <span className="text-zinc-800 dark:text-zinc-200">{f.path}</span>
                </span>
                <span className="shrink-0 text-[11px]">
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
          className="max-h-[36rem] overflow-auto rounded-lg border border-zinc-200/80 bg-zinc-50/50 font-mono text-xs leading-5 dark:border-zinc-800/80 dark:bg-zinc-950"
        >
          {job.diff.split("\n").map((line, i) => (
            <div key={i} className={`whitespace-pre px-3 ${lineClass(line)}`}>
              {line || " "}
            </div>
          ))}
        </pre>
        {v && (
          <p className="font-mono text-[11px] text-zinc-500 [overflow-wrap:anywhere]">
            sha256 {v.diff.hash}
            {v.diff.truncated ? " · diff truncated for display" : ""}
          </p>
        )}
      </div>
    </Panel>
  );
}

/** The executor's own reports: claims, not evidence. Collapsed by default. */
export function ExecutorAttempts({ job }: { job: Job }) {
  if (job.execution.length === 0) return null;
  return (
    <CollapsiblePanel
      title="Executor Attempts"
      summary={`${job.execution.length} ${job.execution.length === 1 ? "attempt" : "attempts"} · agent claims, not evidence`}
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
