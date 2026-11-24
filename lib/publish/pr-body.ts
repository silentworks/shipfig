import type { PlanRecord } from "@/lib/agent/planner";
import type { Job, TestResult } from "@/lib/jobs/store";

/**
 * The draft PR text: issue link, summary, changed files, the exact commands
 * Shipfig ran with their exit codes and output, missing checks and risks.
 *
 * Issue text and model output are untrusted. They are rendered inert: no
 * @-mentions (which would notify people), no raw HTML, and command output
 * only inside code fences that it cannot break out of.
 */

const MAX_BODY_CHARS = 60_000;
const MAX_OUTPUT_LINES = 30;

function inertProse(text: string): string {
  return (
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      // Break @-mentions and cross-repo references (owner/repo#1) without changing what a reader sees.
      .replace(/@(?=[A-Za-z0-9_-])/g, "@\u200b")
      .replace(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(?=\d)/g, "$1\u200b#")
  );
}

/**
 * Plain text safe to place in Markdown prose. Inline code spans are kept
 * verbatim: GitHub renders them literally (no HTML, mentions or references),
 * so escaping inside them would show the escapes.
 */
export function inert(text: string, max = 2_000): string {
  const cleaned = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  let out = "";
  let last = 0;
  for (const m of cleaned.matchAll(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g)) {
    out += inertProse(cleaned.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  out += inertProse(cleaned.slice(last));
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** One-line variant for list items and table cells. */
export function inertLine(text: string, max = 300): string {
  return inert(text.replace(/\s+/g, " "), max).replace(/\|/g, "\\|");
}

/** A fenced code block whose fence is longer than any backtick run in the content. */
export function codeBlock(content: string): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${content.replace(/@(?=[A-Za-z0-9_-])/g, "@​")}\n${fence}`;
}

function lastLines(output: string, n = MAX_OUTPUT_LINES): string {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, "").trimEnd().split("\n");
  return lines.length <= n ? lines.join("\n") : [`… ${lines.length - n} earlier line(s) omitted`, ...lines.slice(-n)].join("\n");
}

function resultLabel(r: TestResult): string {
  if (r.status === "not_run") return "not run (no script)";
  if (r.status === "timed_out") return "timed out";
  return r.status;
}

function resultsTable(results: readonly TestResult[]): string {
  const rows = results.map(
    (r) => `| \`${r.command.join(" ")}\` | ${resultLabel(r)} | ${r.exitCode ?? "—"} | ${r.durationMs === null ? "—" : `${(r.durationMs / 1000).toFixed(1)}s`} | ${inertLine(r.summary ?? "")} |`,
  );
  return ["| Command | Result | Exit code | Time | Summary |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}

export function pullRequestTitle(job: Pick<Job, "issueNumber" | "issueTitle">): string {
  const title = job.issueTitle.replace(/\s+/g, " ").trim();
  return `Fix #${job.issueNumber}: ${title.length > 200 ? `${title.slice(0, 199)}…` : title}`;
}

export function commitMessage(job: Pick<Job, "id" | "issueNumber" | "issueTitle">, plan: PlanRecord): string {
  const summary = plan.plan.summary.replace(/@(?=[A-Za-z0-9_-])/g, "@​").trim();
  return `${pullRequestTitle(job)}\n\n${summary.length > 1_500 ? `${summary.slice(0, 1_499)}…` : summary}\n\nPrepared by Shipfig job ${job.id}.`;
}

export function pullRequestBody(job: Job, plan: PlanRecord, context: { baseMoved: boolean } = { baseMoved: false }): string {
  const v = job.verification;
  const sections: string[] = [];

  sections.push(`Fixes #${job.issueNumber}: [${inertLine(job.issueTitle, 200)}](${job.issueUrl})`);
  sections.push(`## Summary\n\n${inert(plan.plan.summary)}`);

  const files = v?.diff.files ?? [];
  if (files.length > 0) {
    const list = files.map((f) => `- \`${inertLine(f.path)}\` (${f.status}${f.additions === null ? ", binary" : `, +${f.additions} −${f.deletions}`})`);
    sections.push(`## Changed files\n\n${list.join("\n")}`);
  }

  const verificationLines: string[] = [];
  const outcome = v?.outcome === "verified" ? "**Verified**: every requested check ran and exited 0." : v?.outcome === "unverified" ? "**Unverified**: nothing failed, but some requested checks could not run. Missing checks are not passing checks." : "**Not verified**.";
  verificationLines.push(`Shipfig ran these commands itself in an isolated [Fly.io Sprite](https://sprites.dev) after the change. Results come from real exit codes, not from the agent's report. ${outcome}`);
  verificationLines.push(resultsTable(job.testResults));
  if (job.baselineResults.length > 0) verificationLines.push(`Before the change (baseline):\n\n${resultsTable(job.baselineResults)}`);
  const missing = v?.missingChecks ?? [];
  verificationLines.push(missing.length > 0 ? `Missing checks (requested, but the repository has no script for them): ${missing.map((c) => `\`${c}\``).join(", ")}` : "Missing checks: none.");
  for (const r of job.testResults.filter((t) => t.output && t.status !== "not_run")) {
    verificationLines.push(`<details><summary>Output of <code>${r.command.join(" ")}</code> (exit ${r.exitCode ?? "—"})</summary>\n\n${codeBlock(lastLines(r.output))}\n\n</details>`);
  }
  sections.push(`## Verification\n\n${verificationLines.join("\n\n")}`);

  const risks = [...plan.plan.risks.map((r) => inertLine(r, 500))];
  for (const flag of v?.flags ?? []) risks.push(`Shipfig flag: ${inertLine(flag, 300)}`);
  for (const concern of v?.review?.concerns ?? []) risks.push(`Model review: ${inertLine(concern, 500)}`);
  if (v?.reviewError) risks.push(`Model review unavailable: ${inertLine(v.reviewError, 300)}`);
  if (context.baseMoved) risks.push(`\`${job.baseBranch}\` has moved since this change was prepared; check for conflicts.`);
  sections.push(`## Risks\n\n${risks.length > 0 ? risks.map((r) => `- ${r}`).join("\n") : "None noted."}`);

  const approval = job.publishApprovedAt ? `Publishing approved by ${inertLine(job.publishApprovedBy ?? "unknown", 100)} at ${job.publishApprovedAt}` : "Publishing approved";
  sections.push(
    `---\n<sub>Draft opened by Shipfig job \`${job.id}\` from \`${job.baseBranch}\`@${job.baseSha?.slice(0, 12)}. ${approval} for diff sha256 \`${job.diffHash}\`. Plan approved ${job.planApprovedAt ?? "—"}. Shipfig never merges; review before marking ready.</sub>`,
  );

  const body = sections.join("\n\n");
  return body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS - 60)}\n\n…(truncated; see the Shipfig job for full evidence)` : body;
}
