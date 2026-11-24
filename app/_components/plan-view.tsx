"use client";

import type { PlanRecord } from "@/lib/agent/planner";
import type { Job } from "@/lib/jobs/store";
import { Button, CollapsiblePanel, Panel, StatusBadge } from "./ui";

function List({ items, mono = false }: { items: string[]; mono?: boolean }) {
  if (items.length === 0) return <p className="text-sm text-zinc-500">None</p>;
  return (
    <ul className={`list-disc space-y-1.5 pl-4 text-sm text-zinc-700 dark:text-zinc-300 ${mono ? "font-mono text-xs" : ""}`}>
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
      <h3 className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{title}</h3>
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
  highlightApproval = false,
}: {
  job: Job;
  busy: boolean;
  onDecision(decision: "approve" | "reject"): void;
  collapsible?: boolean;
  highlightApproval?: boolean;
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
          <p className="font-medium">Needs clarification before continuing</p>
          <p className="mt-1 whitespace-pre-wrap break-words">{plan.clarificationQuestion}</p>
        </div>
      )}

      <Section title="Summary">
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">{plan.summary}</p>
      </Section>

      <Section title="What will change">
        <List items={plan.changes} />
      </Section>

      <Section title="Files to update">
        <List
          mono
          items={[
            ...record.existingFiles,
            ...record.newFiles.map((f) => `${f} (new)`),
            ...record.invalidFiles.map((f) => `${f} (ignored: invalid path)`),
          ]}
        />
      </Section>

      <Section title="Checks to run">
        <p className="text-sm text-zinc-700 dark:text-zinc-300">
          {record.runnableChecks.length > 0 ? record.runnableChecks.join(", ") : "No automated checks configured"}
          {record.missingChecks.length > 0 && (
            <span className="text-xs text-amber-700 dark:text-amber-300">
              {" "}
              · missing scripts: {record.missingChecks.join(", ")}
            </span>
          )}
        </p>
      </Section>

      {plan.risks.length > 0 && (
        <Section title="Things to watch out for">
          <List items={plan.risks} />
        </Section>
      )}

      {awaiting && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/35 bg-amber-500/10 px-4 py-3">
          <p className="text-xs text-amber-950 dark:text-amber-100">
            Approving lets Shipfig make these edits and run checks in an isolated workspace. Nothing is pushed to GitHub without your final approval.
          </p>
          <div className="flex shrink-0 gap-2">
            <Button variant="secondary" onClick={() => onDecision("reject")} disabled={busy}>
              Reject
            </Button>
            <Button onClick={() => onDecision("approve")} disabled={busy}>
              Approve plan
            </Button>
          </div>
        </div>
      )}

      {job.planApprovedAt && (
        <p className="text-xs text-zinc-500">
          Approved by {job.planApprovedBy} on <time dateTime={job.planApprovedAt}>{new Date(job.planApprovedAt).toLocaleString()}</time>
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
      title="Proposed plan"
      className={highlightApproval ? "ring-1 ring-amber-500/35" : ""}
      actions={
        awaiting ? (
          <StatusBadge tone="waiting">Waiting for your approval</StatusBadge>
        ) : job.planApprovedAt ? (
          <StatusBadge tone="completed">Approved</StatusBadge>
        ) : null
      }
    >
      {content}
    </Panel>
  );
}
