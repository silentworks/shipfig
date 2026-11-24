"use client";

import type { PlanRecord } from "@/lib/agent/planner";
import type { Job } from "@/lib/jobs/store";
import { Button, CollapsiblePanel, Panel, StatusBadge } from "./ui";

function List({ items, mono = false }: { items: string[]; mono?: boolean }) {
  if (items.length === 0) return <p className="text-xs text-zinc-500">None</p>;
  return (
    <ul className={`list-disc space-y-1 pl-4 text-sm text-zinc-800 dark:text-zinc-200 ${mono ? "font-mono text-xs" : ""}`}>
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
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{title}</h3>
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
  collapsible = false,
}: {
  job: Job;
  busy: boolean;
  onDecision(decision: "approve" | "reject"): void;
  collapsible?: boolean;
}) {
  const record = job.plan as PlanRecord | null;
  if (!record?.plan) return null;
  const { plan } = record;
  const awaiting = job.state === "awaiting_plan_approval";

  const content = (
    <div className="flex flex-col gap-4">
      {plan.needsClarification && (
        <div
          role="alert"
          className="rounded-lg border border-amber-500/35 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200"
        >
          <p className="font-medium">Needs clarification. Nothing was changed.</p>
          <p className="mt-1 whitespace-pre-wrap break-words">{plan.clarificationQuestion}</p>
        </div>
      )}
      <Section title="Summary">
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">{plan.summary}</p>
      </Section>
      <Section title="Proposed changes">
        <List items={plan.changes} />
      </Section>
      <Section title="Files">
        <List
          mono
          items={[
            ...record.existingFiles,
            ...record.newFiles.map((f) => `${f} (new)`),
            ...record.invalidFiles.map((f) => `${f} (rejected: invalid path)`),
          ]}
        />
      </Section>
      <Section title="Verification">
        <p className="text-sm text-zinc-800 dark:text-zinc-200">
          {record.runnableChecks.length > 0 ? (
            <span className="font-mono text-xs">{record.runnableChecks.map((c) => `npm run ${c}`).join(", ")}</span>
          ) : (
            "No runnable checks"
          )}
          {record.missingChecks.length > 0 && (
            <span className="text-xs text-amber-700 dark:text-amber-300">
              {" "}
              · no script for {record.missingChecks.join(", ")} (reported as missing, not passing)
            </span>
          )}
        </p>
      </Section>
      {plan.risks.length > 0 && (
        <Section title="Risks">
          <List items={plan.risks} />
        </Section>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 pt-3 text-[11px] text-zinc-500 dark:border-zinc-900">
        <span className="font-mono">
          {record.analysis.model} · {record.analysis.turns} turns · {record.analysis.toolCalls} tool calls ·{" "}
          {record.analysis.filesRead.length} files read · {record.analysis.inputTokens + record.analysis.outputTokens} tokens
        </span>
        {job.planApprovedAt && (
          <span>
            Approved by {job.planApprovedBy} at <time dateTime={job.planApprovedAt}>{new Date(job.planApprovedAt).toLocaleString()}</time>
          </span>
        )}
      </div>
      {awaiting && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Approving lets Shipfig edit the checkout in its isolated Sprite and run checks. Nothing is published without a second approval.
        </p>
      )}
    </div>
  );

  if (collapsible && !awaiting) {
    return (
      <CollapsiblePanel
        title="Plan"
        badge={job.planApprovedAt ? <StatusBadge tone="completed">Approved</StatusBadge> : undefined}
        summary={plan.summary}
        defaultOpen={false}
      >
        {content}
      </CollapsiblePanel>
    );
  }

  return (
    <Panel
      title="Plan"
      actions={
        awaiting ? (
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => onDecision("reject")} disabled={busy}>
              Reject
            </Button>
            <Button size="sm" onClick={() => onDecision("approve")} disabled={busy}>
              Approve plan
            </Button>
          </div>
        ) : job.planApprovedAt ? (
          <StatusBadge tone="completed">Approved</StatusBadge>
        ) : null
      }
    >
      {content}
    </Panel>
  );
}
