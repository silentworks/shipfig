"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Repo } from "@/lib/github/schemas";
import { STATE_LABELS } from "@/lib/jobs/states";
import type { Job } from "@/lib/jobs/store";
import { fetchJson } from "./api";
import { Kbd } from "./ui";

interface PaletteItem {
  id: string;
  group: "Navigation" | "Active Job" | "Recent Jobs" | "Repositories";
  label: string;
  subtitle?: string;
  href: string;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <CommandPaletteDialog onClose={onClose} />;
}

function CommandPaletteDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus());

    let cancelled = false;
    fetchJson<{ jobs: Job[]; activeJobId: string | null }>("/api/jobs")
      .then((data) => {
        if (cancelled) return;
        setJobs(data.jobs);
        setActiveJobId(data.activeJobId);
      })
      .catch(() => {});

    fetchJson<{ repos: Repo[] }>("/api/repos")
      .then((data) => {
        if (cancelled) return;
        setRepos(data.repos);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, []);

  const items = useMemo<PaletteItem[]>(() => {
    const all: PaletteItem[] = [
      { id: "nav-issues", group: "Navigation", label: "Issues", subtitle: "Pick a GitHub issue to run", href: "/" },
      { id: "nav-jobs", group: "Navigation", label: "Jobs", subtitle: "View all runs and history", href: "/jobs" },
    ];

    const active = jobs.find((j) => j.id === activeJobId);
    if (active) {
      all.push({
        id: `active-${active.id}`,
        group: "Active Job",
        label: `${active.repoOwner}/${active.repoName}#${active.issueNumber} · ${active.issueTitle}`,
        subtitle: `${STATE_LABELS[active.state]} · ${active.id}`,
        href: `/jobs/${active.id}`,
      });
    }

    for (const j of jobs.slice(0, 8)) {
      if (j.id === activeJobId) continue;
      all.push({
        id: `job-${j.id}`,
        group: "Recent Jobs",
        label: `${j.repoOwner}/${j.repoName}#${j.issueNumber} · ${j.issueTitle}`,
        subtitle: `${STATE_LABELS[j.state]} · ${j.id}`,
        href: `/jobs/${j.id}`,
      });
    }

    for (const r of repos) {
      all.push({
        id: `repo-${r.fullName}`,
        group: "Repositories",
        label: r.fullName,
        subtitle: "Browse open issues",
        href: `/?repo=${encodeURIComponent(r.fullName)}`,
      });
    }

    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        (item.subtitle && item.subtitle.toLowerCase().includes(q)) ||
        item.group.toLowerCase().includes(q),
    );
  }, [jobs, activeJobId, repos, query]);

  const clampedIndex = items.length === 0 ? 0 : Math.min(selectedIndex, items.length - 1);

  function navigate(href: string) {
    onClose();
    router.push(href);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length > 0) setSelectedIndex((i) => (i + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length > 0) setSelectedIndex((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === "Enter" && items[clampedIndex]) {
      e.preventDefault();
      navigate(items[clampedIndex].href);
    }
  }

  let currentGroup: string | null = null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[14vh] backdrop-blur-[2px]"
      onClick={onClose}
      onKeyDown={onKeyDown}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-zinc-200/80 px-3.5 py-2.5 dark:border-zinc-800/80">
          <svg aria-hidden viewBox="0 0 16 16" fill="none" className="h-4 w-4 shrink-0 text-zinc-400">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5L13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Jump to issues, jobs, or repositories…"
            className="w-full bg-transparent text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-100"
          />
          <Kbd>ESC</Kbd>
        </div>

        <div className="max-h-80 overflow-y-auto p-1.5">
          {items.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-zinc-500">No matches for &ldquo;{query}&rdquo;</p>
          ) : (
            items.map((item, idx) => {
              const showGroup = item.group !== currentGroup;
              currentGroup = item.group;
              const active = idx === clampedIndex;
              return (
                <div key={item.id}>
                  {showGroup && (
                    <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 first:pt-1">
                      {item.group}
                    </p>
                  )}
                  <button
                    type="button"
                    onMouseEnter={() => setSelectedIndex(idx)}
                    onClick={() => navigate(item.href)}
                    className={`flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                      active
                        ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800/90 dark:text-zinc-100"
                        : "text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-900"
                    }`}
                  >
                    <span className="min-w-0 truncate font-medium">{item.label}</span>
                    {item.subtitle && <span className="shrink-0 truncate text-xs text-zinc-500">{item.subtitle}</span>}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t border-zinc-200/80 px-3.5 py-2 text-[11px] text-zinc-500 dark:border-zinc-800/80">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> navigate
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> open
            </span>
          </div>
          <span>Shipfig</span>
        </div>
      </div>
    </div>
  );
}
