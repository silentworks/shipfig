"use client";

import type { Job, TestResult } from "@/lib/jobs/store";
import type { VerificationOutcome } from "@/lib/verify/evidence";
import { Panel } from "./ui";

const OUTCOME: Record<VerificationOutcome, { label: string; tone: string; detail: string }> = {
  verified: {
    label: "Verified",
    tone: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
    detail: "Every requested check ran and exited 0.",
  },
  unverified: {
    label: "Unverified",
    tone: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
    detail: "Nothing failed, but some requested checks could not run. Missing checks are not passing checks.",
  },
  failed: {
    label: "Checks failed",
    tone: "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200",
    detail: "At least one check did not exit 0.",
  },
};

const STATUS: Record<TestResult["status"], string> = {
  passed: "text-emerald-700 dark:text-emerald-300",
  failed: "text-red-700 dark:text-red-300",
  timed_out: "text-red-700 dark:text-red-300",
  not_run: "text-amber-700 dark:text-amber-300",
};

function ResultsTable({ results, caption }: { results: TestResult[]; caption: string }) {
  if (results.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="mb-1 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">{caption}</caption>
        <thead className="text-xs text-zinc-500">
          <tr>
            <th className="py-1 pr-4 font-medium">Command</th>
            <th className="py-1 pr-4 font-medium">Result</th>
            <th className="py-1 pr-4 font-medium">Exit</th>
            <th className="py-1 pr-4 font-medium">Time</th>
            <th className="py-1 font-medium">Summary</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r, i) => (
            <tr key={i} className="border-t border-zinc-100 align-top dark:border-zinc-900">
              <td className="py-1.5 pr-4 font-mono text-xs">{r.command.join(" ")}</td>
              <td className={`py-1.5 pr-4 font-medium ${STATUS[r.status]}`}>{r.status.replace("_", " ")}</td>
              <td className="py-1.5 pr-4 font-mono text-xs">{r.exitCode ?? "—"}</td>
              <td className="py-1.5 pr-4 text-xs">{r.durationMs === null ? "—" : `${(r.durationMs / 1000).toFixed(1)}s`}</td>
              <td className="py-1.5 text-xs">
                {r.summary ?? ""}
                {r.output && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-zinc-500">Output</summary>
                    <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-50 p-2 font-mono text-[11px] dark:bg-zinc-900">{r.output}</pre>
                  </details>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index ")) return "text-zinc-500";
  if (line.startsWith("@@")) return "text-sky-700 dark:text-sky-300";
  if (line.startsWith("+")) return "bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200";
  if (line.startsWith("-")) return "bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200";
  return "";
}

/** Verification evidence: outcome, real check results, flags, review and the exact diff. */
export function EvidenceView({ job }: { job: Job }) {
  const v = job.verification;
  if (!v && job.testResults.length === 0 && !job.diff) return null;
  const outcome = v ? OUTCOME[v.outcome] : null;

  return (
    <Panel title="Verification">
      <div className="flex flex-col gap-5">
        {outcome && (
          <div className={`rounded-md border p-3 text-sm ${outcome.tone}`}>
            <p className="font-semibold">{outcome.label}</p>
            <p>{outcome.detail}</p>
          </div>
        )}
        <ResultsTable results={job.testResults} caption="Checks run by Shipfig after the change" />
        <ResultsTable results={job.baselineResults} caption="Baseline (before any change)" />

        {v && v.flags.length > 0 && (
          <div>
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Flags</h3>
            <ul className="list-disc space-y-1 pl-5 text-sm text-amber-800 dark:text-amber-300">
              {v.flags.map((f, i) => (
                <li key={i} className="break-words">
                  {f}
                </li>
              ))}
            </ul>
          </div>
        )}

        {v && (v.review || v.reviewError) && (
          <div>
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Model review (can block, never approves)</h3>
            {v.review ? (
              <div className="text-sm">
                <p className={v.review.verdict === "pass" ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}>Verdict: {v.review.verdict}</p>
                {v.review.concerns.length > 0 && (
                  <ul className="mt-1 list-disc pl-5">
                    {v.review.concerns.map((c, i) => (
                      <li key={i} className="break-words">
                        {c}
                      </li>
                    ))}
                  </ul>
                )}
                {v.review.evidence.length > 0 && <p className="mt-1 text-xs text-zinc-500">Evidence: {v.review.evidence.join(" · ")}</p>}
              </div>
            ) : (
              <p className="text-sm text-amber-800 dark:text-amber-300">Review unavailable: {v.reviewError}</p>
            )}
          </div>
        )}

        {job.diff && (
          <div>
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Diff{v ? ` · ${v.diff.files.length} file(s), +${v.diff.additions} −${v.diff.deletions}` : ""}
            </h3>
            {v && (
              <ul className="mb-2 font-mono text-xs">
                {v.diff.files.map((f) => (
                  <li key={f.path}>
                    {f.status.padEnd(8)} {f.path} {f.additions === null ? "(binary)" : `+${f.additions} −${f.deletions}`}
                  </li>
                ))}
              </ul>
            )}
            <pre className="max-h-[36rem] overflow-auto rounded-md border border-zinc-200 font-mono text-xs leading-5 dark:border-zinc-800">
              {job.diff.split("\n").map((line, i) => (
                <div key={i} className={`whitespace-pre px-3 ${lineClass(line)}`}>
                  {line || " "}
                </div>
              ))}
            </pre>
            {v && (
              <p className="mt-1 font-mono text-[11px] text-zinc-500">
                sha256 {v.diff.hash}
                {v.diff.truncated ? " · diff truncated for display" : ""}
              </p>
            )}
          </div>
        )}

        {job.execution.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">Executor attempts ({job.execution.length}): its own claims, not evidence</summary>
            <ol className="mt-2 flex flex-col gap-2">
              {job.execution.map((a) => {
                const report = a.report as { summary?: string } | null;
                return (
                  <li key={a.attempt} className="rounded-md bg-zinc-50 p-2 dark:bg-zinc-900">
                    <p className="font-medium">{a.attempt === 0 ? "First attempt" : `Repair ${a.attempt}`}</p>
                    {report?.summary && <p className="whitespace-pre-wrap break-words">{report.summary}</p>}
                    <p className="text-xs text-zinc-500">
                      wrote {a.filesWritten.join(", ") || "nothing"}
                      {a.refusals.length > 0 ? ` · refused: ${a.refusals.join("; ")}` : ""} · {a.usage.turns} turns
                    </p>
                  </li>
                );
              })}
            </ol>
          </details>
        )}
      </div>
    </Panel>
  );
}
