"use client";

import { useState } from "react";
import { CHECKS, type Check, type PlanEdit, type PlanRecord } from "@/lib/agent/planner";
import type { Job } from "@/lib/jobs/store";
import { Button, CollapsiblePanel, ErrorNotice, Panel, StatusBadge } from "./ui";

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

function EditableStringList({
  label,
  items,
  onChange,
  maxItems,
  placeholder,
  addLabel,
  mono = false,
  disabled,
}: {
  label: string;
  items: string[];
  onChange(next: string[]): void;
  maxItems: number;
  placeholder: string;
  addLabel: string;
  mono?: boolean;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
          {label} ({items.length}/{maxItems})
        </span>
        {items.length < maxItems && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange([...items, ""])}
            className="text-xs font-medium text-sky-600 hover:text-sky-700 disabled:opacity-50 dark:text-sky-400 dark:hover:text-sky-300"
          >
            + {addLabel}
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="text-xs italic text-zinc-400">None</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {items.map((item, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                type="text"
                value={item}
                disabled={disabled}
                placeholder={placeholder}
                aria-label={`${label} ${idx + 1}`}
                onChange={(e) => {
                  const next = [...items];
                  next[idx] = e.target.value;
                  onChange(next);
                }}
                className={`h-8 flex-1 rounded-md border border-zinc-200 bg-white px-2.5 text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500 ${
                  mono ? "font-mono text-xs" : "text-sm"
                }`}
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(items.filter((_, i) => i !== idx))}
                aria-label={`Remove ${label.toLowerCase()} ${idx + 1}`}
                className="inline-flex h-8 shrink-0 items-center rounded-md border border-zinc-200 px-2 text-xs text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PlanEditor({
  record,
  availableScripts,
  busy,
  onSave,
  onCancel,
}: {
  record: PlanRecord;
  availableScripts: Record<string, string>;
  busy: boolean;
  onSave(edit: PlanEdit, andApprove: boolean): Promise<void>;
  onCancel(): void;
}) {
  const [summary, setSummary] = useState(record.plan.summary);
  const [changes, setChanges] = useState<string[]>(record.plan.changes.length > 0 ? record.plan.changes : [""]);
  const [files, setFiles] = useState<string[]>([...record.existingFiles, ...record.newFiles]);
  const [checks, setChecks] = useState<Check[]>(record.plan.checks);
  const [risks, setRisks] = useState<string[]>(record.plan.risks);
  const [saveError, setSaveError] = useState<string | null>(null);

  function toggleCheck(check: Check) {
    setChecks((prev) => (prev.includes(check) ? prev.filter((c) => c !== check) : [...prev, check]));
  }

  async function submit(andApprove: boolean) {
    setSaveError(null);
    const cleanedSummary = summary.trim();
    const cleanedChanges = changes.map((c) => c.trim()).filter(Boolean);
    const cleanedFiles = files.map((f) => f.trim()).filter(Boolean);
    const cleanedRisks = risks.map((r) => r.trim()).filter(Boolean);

    if (!cleanedSummary) {
      setSaveError("Summary is required.");
      return;
    }
    if (cleanedChanges.length === 0) {
      setSaveError("Add at least one concrete change before saving.");
      return;
    }

    try {
      await onSave(
        {
          summary: cleanedSummary,
          changes: cleanedChanges,
          files: cleanedFiles,
          checks,
          risks: cleanedRisks,
        },
        andApprove,
      );
      onCancel();
    } catch (e) {
      setSaveError((e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {saveError && <ErrorNotice message={saveError} />}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="plan-edit-summary" className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
          Summary
        </label>
        <textarea
          id="plan-edit-summary"
          rows={3}
          value={summary}
          disabled={busy}
          maxLength={1500}
          onChange={(e) => setSummary(e.target.value)}
          className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500"
        />
      </div>

      <EditableStringList
        label="What will change"
        items={changes}
        onChange={setChanges}
        maxItems={8}
        placeholder="Describe a concrete change…"
        addLabel="Add step"
        disabled={busy}
      />

      <div className="flex flex-col gap-1">
        <EditableStringList
          label="Files to update"
          items={files}
          onChange={setFiles}
          maxItems={12}
          placeholder="src/example.ts"
          addLabel="Add file"
          mono
          disabled={busy}
        />
        <p className="text-[11px] text-zinc-400">
          Repo-relative paths only. Protected files (secrets, CI, deployment, package.json, lockfiles) are refused.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Checks to run</span>
        <div className="flex flex-wrap gap-2">
          {CHECKS.map((check) => {
            const checked = checks.includes(check);
            const hasScript = check in availableScripts;
            return (
              <label
                key={check}
                className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  checked
                    ? "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-700 dark:bg-sky-950/60 dark:text-sky-200"
                    : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={busy}
                  onChange={() => toggleCheck(check)}
                  className="h-3.5 w-3.5 accent-sky-600"
                />
                <span>{check}</span>
                {!hasScript && <span className="text-[10px] text-amber-600 dark:text-amber-400">(no script)</span>}
              </label>
            );
          })}
        </div>
      </div>

      <EditableStringList
        label="Things to watch out for"
        items={risks}
        onChange={setRisks}
        maxItems={8}
        placeholder="Edge case or risk to keep in mind…"
        addLabel="Add risk"
        disabled={busy}
      />

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-200/80 pt-3 dark:border-zinc-800/80">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="secondary" onClick={() => submit(false)} disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </Button>
        <Button onClick={() => submit(true)} disabled={busy}>
          {busy ? "Saving…" : "Save & approve"}
        </Button>
      </div>
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
  onSavePlan,
  collapsible = false,
  highlightApproval = false,
}: {
  job: Job;
  busy: boolean;
  onDecision(decision: "approve" | "reject"): void;
  onSavePlan?(edit: PlanEdit, andApprove: boolean): Promise<void>;
  collapsible?: boolean;
  highlightApproval?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const record = job.plan as PlanRecord | null;
  if (!record?.plan) return null;
  const { plan } = record;
  const awaiting = job.state === "awaiting_plan_approval";
  const isEditing = awaiting && editing && Boolean(onSavePlan);

  const content = isEditing ? (
    <PlanEditor
      key={job.version}
      record={record}
      availableScripts={job.workspace?.scripts ?? {}}
      busy={busy}
      onSave={onSavePlan!}
      onCancel={() => setEditing(false)}
    />
  ) : (
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
          <div className="flex shrink-0 flex-wrap gap-2">
            {onSavePlan && (
              <Button variant="secondary" onClick={() => setEditing(true)} disabled={busy}>
                Edit plan
              </Button>
            )}
            <Button variant="secondary" onClick={() => onDecision("reject")} disabled={busy}>
              Reject
            </Button>
            <Button onClick={() => onDecision("approve")} disabled={busy}>
              Approve plan
            </Button>
          </div>
        </div>
      )}

      {record.edited && (
        <p className="text-xs text-zinc-500">
          Edited by {record.edited.editedBy} on <time dateTime={record.edited.editedAt}>{new Date(record.edited.editedAt).toLocaleString()}</time>
        </p>
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
      title={isEditing ? "Edit proposed plan" : "Proposed plan"}
      className={highlightApproval ? "ring-1 ring-amber-500/35" : ""}
      actions={
        <div className="flex items-center gap-2">
          {record.edited && (
            <span className="rounded border border-sky-200/80 bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:border-sky-800/60 dark:bg-sky-950/60 dark:text-sky-300">
              Edited
            </span>
          )}
          {awaiting ? (
            <StatusBadge tone="waiting">Waiting for your approval</StatusBadge>
          ) : job.planApprovedAt ? (
            <StatusBadge tone="completed">Approved</StatusBadge>
          ) : null}
        </div>
      }
    >
      {content}
    </Panel>
  );
}
