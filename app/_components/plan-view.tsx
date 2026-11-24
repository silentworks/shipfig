"use client";

import type { PlanRecord } from "@/lib/agent/planner";
import type { Job } from "@/lib/jobs/store";
import { Button, Panel } from "./ui";

function List({ items, mono = false }: { items: string[]; mono?: boolean }) {
  if (items.length === 0) return <p className="text-sm text-zinc-500">None</p>;
  return (
    <ul className={`list-disc space-y-1 pl-5 text-sm ${mono ? "font-mono text-xs" : ""}`}>
      {items.map((item, i) => (
        <li key={i} className="break-words">
          {item}
        </li>
      ))}
    </ul>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">{title}</h3>
      {children}
    </div>
  );
}

/**
 * The structured plan, rendered as plain text (model output derived from
 * untrusted input is never rendered as HTML or markdown).
 */
export function PlanView({
  job,
  busy,
  onDecision,
}: {
  job: Job;
  busy: boolean;
  onDecision(decision: "approve" | "reject"): void;
}) {
  const record = job.plan as PlanRecord | null;
  if (!record?.plan) return null;
  const { plan } = record;
  const awaiting = job.state === "awaiting_plan_approval";

  return (
    <Panel
      title="Plan"
      actions={
        awaiting ? (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => onDecision("reject")} disabled={busy}>
              Reject
            </Button>
            <Button onClick={() => onDecision("approve")} disabled={busy}>
              Approve plan
            </Button>
          </div>
        ) : job.planApprovedAt ? (
          <span className="text-xs text-zinc-500">
            Approved by {job.planApprovedBy} at <time dateTime={job.planApprovedAt}>{new Date(job.planApprovedAt).toLocaleString()}</time>
          </span>
        ) : null
      }
    >
      <div className="flex flex-col gap-4">
        {plan.needsClarification && (
          <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <p className="font-medium">Needs clarification. Nothing was changed.</p>
            <p className="mt-1 whitespace-pre-wrap break-words">{plan.clarificationQuestion}</p>
          </div>
        )}
        <Section title="Summary">
          <p className="whitespace-pre-wrap break-words text-sm">{plan.summary}</p>
        </Section>
        <Section title="Proposed changes">
          <List items={plan.changes} />
        </Section>
        <Section title="Files">
          <List
            mono
            items={[...record.existingFiles, ...record.newFiles.map((f) => `${f} (new)`), ...record.invalidFiles.map((f) => `${f} (rejected: invalid path)`)]}
          />
        </Section>
        <Section title="Verification">
          <p className="text-sm">
            {record.runnableChecks.length > 0 ? record.runnableChecks.map((c) => `npm run ${c}`).join(", ") : "No runnable checks"}
            {record.missingChecks.length > 0 && (
              <span className="text-amber-700 dark:text-amber-300"> · no script for {record.missingChecks.join(", ")} (will be reported as missing, not passing)</span>
            )}
          </p>
        </Section>
        <Section title="Risks">
          <List items={plan.risks} />
        </Section>
        <p className="text-xs text-zinc-500">
          {record.analysis.model} · {record.analysis.turns} turns · {record.analysis.toolCalls} tool calls · read {record.analysis.filesRead.length} files ·{" "}
          {record.analysis.inputTokens + record.analysis.outputTokens} tokens
        </p>
        {awaiting && <p className="text-sm text-zinc-600 dark:text-zinc-400">Approving lets Shipfig edit the checkout in its sprite and run the checks. Nothing is published without a second approval.</p>}
      </div>
    </Panel>
  );
}
