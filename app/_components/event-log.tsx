"use client";

import { useEffect, useRef, useState } from "react";
import type { JobEvent } from "@/lib/jobs/store";
import { CollapsiblePanel, StatusBadge } from "./ui";

type Filter = "all" | "command" | "error";

const KIND_TONE: Record<JobEvent["kind"], string> = {
  transition: "text-sky-300",
  info: "text-zinc-300",
  command: "text-zinc-100",
  error: "text-red-300",
};

function commandExit(e: JobEvent): number | null {
  const data = e.data as { exitCode?: number | null } | null;
  return typeof data?.exitCode === "number" ? data.exitCode : null;
}

/**
 * The job's event log as a collapsible terminal. Follows new output while
 * scrolled to the bottom; stays collapsed by default when not actively running.
 */
export function EventLog({ events, defaultOpen = false }: { events: JobEvent[]; defaultOpen?: boolean }) {
  const [filter, setFilter] = useState<Filter>("all");
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const shown = events.filter(
    (e) => filter === "all" || e.kind === filter || (filter === "error" && e.kind === "command" && (commandExit(e) ?? 0) !== 0),
  );

  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  const counts = {
    all: events.length,
    command: events.filter((e) => e.kind === "command").length,
    error: events.filter((e) => e.kind === "error" || (e.kind === "command" && (commandExit(e) ?? 0) !== 0)).length,
  };

  return (
    <CollapsiblePanel
      title="Terminal"
      defaultOpen={defaultOpen}
      badge={
        counts.error > 0 ? (
          <StatusBadge tone="failed">{counts.error} problem{counts.error === 1 ? "" : "s"}</StatusBadge>
        ) : (
          <span className="font-mono text-[11px] text-zinc-400">{counts.all} events</span>
        )
      }
      summary={events.length > 0 ? events[events.length - 1].message : "No events yet"}
      actions={
        <div role="group" aria-label="Filter events" className="flex gap-1 text-xs">
          {(["all", "command", "error"] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-zinc-500 ${
                filter === f
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              }`}
            >
              {f === "all" ? "All" : f === "command" ? "Commands" : "Problems"} ({counts[f]})
            </button>
          ))}
        </div>
      }
    >
      <div
        ref={scroller}
        tabIndex={0}
        role="log"
        aria-label="Job event log"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="max-h-[24rem] overflow-auto rounded-md bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-100"
      >
        {shown.length === 0 ? (
          <p className="text-zinc-500">{events.length === 0 ? "No events yet." : "Nothing matches this filter."}</p>
        ) : (
          <ol className="flex flex-col gap-0.5">
            {shown.map((e) => {
              const exit = e.kind === "command" ? commandExit(e) : null;
              const stderr = (e.data as { stderr?: string } | null)?.stderr;
              const error = (e.data as { error?: string } | null)?.error;
              return (
                <li key={e.id} className="flex gap-3">
                  <time dateTime={e.at} title={e.at} className="shrink-0 text-zinc-500">
                    {new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </time>
                  <div className={`min-w-0 [overflow-wrap:anywhere] ${exit !== null && exit !== 0 ? "text-red-300" : KIND_TONE[e.kind]}`}>
                    {e.kind === "transition" && <span className="text-sky-500">▸ </span>}
                    {e.message}
                    {(stderr || error) && (
                      <details>
                        <summary className="cursor-pointer text-zinc-500">{stderr ? "stderr" : "details"}</summary>
                        <pre className="whitespace-pre-wrap text-zinc-400 [overflow-wrap:anywhere]">{stderr ?? error}</pre>
                      </details>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </CollapsiblePanel>
  );
}
