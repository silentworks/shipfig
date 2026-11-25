"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Repo } from "@/lib/github/schemas";
import { AWAITING_HUMAN_STATES, STATE_LABELS } from "@/lib/jobs/states";
import type { Job } from "@/lib/jobs/store";
import { fetchJson } from "./api";
import { CommandPalette } from "./command-palette";
import { Kbd } from "./ui";

const ACTIVE_POLL_MS = 5_000;
const THEME_STORAGE_KEY = "shipfig-theme";
type ThemeMode = "light" | "dark" | "system";

function applyTheme(mode: ThemeMode) {
  const isDark = mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", isDark);
}

function useThemeMode() {
  const [mode, setMode] = useState<ThemeMode>("light");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === "light" || saved === "dark" || saved === "system") {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setMode(saved);
        applyTheme(saved);
      } else {
        applyTheme("light");
      }
    } catch {
      applyTheme("light");
    }
  }, []);

  useEffect(() => {
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  function selectMode(next: ThemeMode) {
    setMode(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore storage errors in restricted contexts.
    }
    applyTheme(next);
  }

  return { mode, selectMode };
}

function ThemeSelector({ mode, onChange }: { mode: ThemeMode; onChange: (mode: ThemeMode) => void }) {
  const options: { value: ThemeMode; label: string; icon: ReactNode }[] = [
    {
      value: "light",
      label: "Light",
      icon: (
        <svg aria-hidden viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
          <circle cx="8" cy="8" r="2.75" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M8 2v1.25M8 12.75V14M2 8h1.25M12.75 8H14M3.76 3.76l.88.88M11.36 11.36l.88.88M12.24 3.76l-.88.88M4.64 11.36l-.88.88"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      ),
    },
    {
      value: "dark",
      label: "Dark",
      icon: (
        <svg aria-hidden viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
          <path
            d="M12.6 10.2A5.25 5.25 0 0 1 5.8 3.4a5.25 5.25 0 1 0 6.8 6.8Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
    {
      value: "system",
      label: "Auto",
      icon: (
        <svg aria-hidden viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
          <rect x="2.25" y="3" width="11.5" height="8" rx="1.25" stroke="currentColor" strokeWidth="1.4" />
          <path d="M5.75 13h4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      ),
    },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className="grid grid-cols-3 gap-0.5 rounded-lg border border-zinc-200/80 bg-zinc-100/80 p-0.5 dark:border-zinc-800 dark:bg-zinc-900"
    >
      {options.map((opt) => {
        const active = mode === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            className={`flex items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors ${
              active
                ? "bg-white text-zinc-900 shadow-xs dark:bg-zinc-800 dark:text-zinc-100"
                : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            }`}
          >
            {opt.icon}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function useJobsOverview() {
  const [data, setData] = useState<{ activeJob: Job | null; totalJobs: number }>({ activeJob: null, totalJobs: 0 });

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      if (document.visibilityState === "hidden") {
        timer = setTimeout(poll, ACTIVE_POLL_MS);
        return;
      }
      try {
        const res = await fetchJson<{ jobs: Job[]; activeJobId: string | null }>("/api/jobs");
        if (!stopped) {
          setData({
            activeJob: res.jobs.find((j) => j.id === res.activeJobId) ?? null,
            totalJobs: res.jobs.length,
          });
        }
      } catch {
        // Keep last known state on transient failure.
      }
      if (!stopped) timer = setTimeout(poll, ACTIVE_POLL_MS);
    }

    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  return data;
}

function useSidebarRepos() {
  const [repos, setRepos] = useState<Repo[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchJson<{ repos: Repo[] }>("/api/repos")
      .then((res) => {
        if (!cancelled) setRepos(res.repos);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(() => {
    const groups = new Map<string, Repo[]>();
    for (const r of repos) {
      const [owner] = r.fullName.split("/");
      const list = groups.get(owner) ?? [];
      list.push(r);
      groups.set(owner, list);
    }
    return Array.from(groups.entries());
  }, [repos]);
}

const NAV_ITEMS = [
  {
    href: "/",
    label: "Issues",
    isActive: (pathname: string) => pathname === "/",
    icon: (
      <svg aria-hidden viewBox="0 0 16 16" fill="none" className="h-4 w-4 shrink-0">
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="8" cy="8" r="1.5" fill="currentColor" />
      </svg>
    ),
  },
  {
    href: "/jobs",
    label: "Jobs",
    isActive: (pathname: string) => pathname === "/jobs" || pathname.startsWith("/jobs/"),
    icon: (
      <svg aria-hidden viewBox="0 0 16 16" fill="none" className="h-4 w-4 shrink-0">
        <path d="M3 4.5H13M3 8H13M3 11.5H9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    ),
  },
];

function SidebarContent({
  pathname,
  selectedRepo,
  repoGroups,
  totalJobs,
}: {
  pathname: string | null;
  selectedRepo: string | null;
  repoGroups: [string, Repo[]][];
  totalJobs: number;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <nav aria-label="Main" className="flex flex-col gap-0.5 px-2.5 pt-2">
        {NAV_ITEMS.map((item) => {
          const active = pathname !== null && item.isActive(pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors ${
                active
                  ? "bg-zinc-200/70 text-zinc-900 dark:bg-zinc-800/80 dark:text-zinc-100"
                  : "text-zinc-600 hover:bg-zinc-200/40 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
              }`}
            >
              <span className="flex items-center gap-2.5">
                {item.icon}
                <span>{item.label}</span>
              </span>
              {item.href === "/jobs" && totalJobs > 0 && (
                <span className="text-xs font-normal text-zinc-400 dark:text-zinc-500">{totalJobs}</span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Repositories grouped by owner — GitScout-style hierarchy */}
      {repoGroups.length > 0 && (
        <div className="mt-4 border-t border-zinc-200/70 px-3 pt-4 dark:border-zinc-800/70">
          <div className="flex flex-col gap-4">
            {repoGroups.map(([owner, repos]) => (
              <div key={owner} className="flex flex-col gap-1">
                <div className="flex items-center gap-2 px-1">
                  <span
                    aria-hidden
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-[9px] font-bold uppercase text-white dark:bg-zinc-200 dark:text-zinc-900"
                  >
                    {owner.slice(0, 1)}
                  </span>
                  <span className="truncate text-xs font-semibold text-zinc-800 dark:text-zinc-200">{owner}</span>
                </div>
                <ul className="flex flex-col gap-0.5 pl-6">
                  {repos.map((r) => {
                    const name = r.fullName.split("/")[1] ?? r.fullName;
                    const active = pathname === "/" && selectedRepo === r.fullName;
                    return (
                      <li key={r.fullName}>
                        <Link
                          href={`/?repo=${encodeURIComponent(r.fullName)}`}
                          aria-current={active ? "location" : undefined}
                          className={`block truncate rounded-md px-1.5 py-1 text-[13px] transition-colors ${
                            active
                              ? "font-medium text-sky-600 dark:text-sky-400"
                              : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                          }`}
                        >
                          {name}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SidebarContentDynamic({ repoGroups, totalJobs }: { repoGroups: [string, Repo[]][]; totalJobs: number }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return <SidebarContent pathname={pathname} selectedRepo={searchParams.get("repo")} repoGroups={repoGroups} totalJobs={totalJobs} />;
}

function MobileNav({ pathname }: { pathname: string | null }) {
  return (
    <nav aria-label="Mobile" className="flex items-center gap-1.5 text-xs md:hidden">
      {NAV_ITEMS.map((item) => {
        const active = pathname !== null && item.isActive(pathname);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`rounded-md px-2 py-1 font-medium ${
              active ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-500"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function MobileNavDynamic() {
  const pathname = usePathname();
  return <MobileNav pathname={pathname} />;
}

function MainFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isIssuesWorkspace = pathname === "/";
  if (isIssuesWorkspace) {
    return <main className="flex min-h-0 flex-1 flex-col">{children}</main>;
  }
  return <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-6 sm:px-6">{children}</main>;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { activeJob, totalJobs } = useJobsOverview();
  const repoGroups = useSidebarRepos();
  const { mode, selectMode } = useThemeMode();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const needsYou = activeJob ? AWAITING_HUMAN_STATES.has(activeJob.state) : false;

  return (
    <div className="flex min-h-screen flex-col md:h-screen md:flex-row md:overflow-hidden">
      {/* Column 1: Persistent sidebar */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-zinc-200/80 bg-zinc-50/80 md:flex dark:border-zinc-800/80 dark:bg-zinc-950">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-200/80 px-3.5 dark:border-zinc-800/80">
          <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-zinc-900 text-[11px] font-bold text-white dark:bg-zinc-100 dark:text-zinc-900">
              S
            </span>
            <span>Shipfig</span>
          </Link>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            title="Jump to… (⌘K)"
            aria-label="Open command palette"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-zinc-400 transition-colors hover:bg-zinc-200/60 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <Kbd>⌘K</Kbd>
          </button>
        </div>

        <Suspense fallback={<SidebarContent pathname={null} selectedRepo={null} repoGroups={repoGroups} totalJobs={totalJobs} />}>
          <SidebarContentDynamic repoGroups={repoGroups} totalJobs={totalJobs} />
        </Suspense>

        <div className="mt-auto flex shrink-0 flex-col gap-2.5 border-t border-zinc-200/70 p-2.5 dark:border-zinc-800/70">
          {activeJob && (
            <Link
              href={`/jobs/${activeJob.id}`}
              className={`block rounded-lg border p-2.5 text-xs transition-colors ${
                needsYou
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-900 hover:bg-amber-500/15 dark:text-amber-200"
                  : "border-zinc-200/80 bg-white text-zinc-800 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900/70 dark:text-zinc-200 dark:hover:border-zinc-700"
              }`}
            >
              <div className="flex items-center gap-1.5 font-medium">
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${needsYou ? "bg-amber-500" : "bg-sky-500 motion-safe:animate-pulse"}`}
                />
                <span className="truncate">{needsYou ? "Needs your approval" : "Active job"}</span>
              </div>
              <p className="mt-1 truncate text-[11px] opacity-85">{activeJob.issueTitle}</p>
              <p className="mt-0.5 truncate text-[11px] opacity-65">{STATE_LABELS[activeJob.state]}</p>
            </Link>
          )}

          <ThemeSelector mode={mode} onChange={selectMode} />
        </div>
      </aside>

      {/* Right side: mobile header + main workspace */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col md:overflow-y-auto">
        <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center justify-between gap-3 border-b border-zinc-200/80 bg-white/90 px-4 backdrop-blur-md md:hidden dark:border-zinc-800/80 dark:bg-zinc-950/90">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/" className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-zinc-900 text-[11px] font-bold text-white dark:bg-zinc-100 dark:text-zinc-900">
                S
              </span>
              <span>Shipfig</span>
            </Link>
            <Suspense fallback={<MobileNav pathname={null} />}>
              <MobileNavDynamic />
            </Suspense>
          </div>

          <div className="flex items-center gap-1.5">
            {activeJob && (
              <Link
                href={`/jobs/${activeJob.id}`}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                  needsYou
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300"
                    : "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                }`}
              >
                <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${needsYou ? "bg-amber-500" : "bg-sky-500 animate-pulse"}`} />
                <span>{needsYou ? "Approve" : "Active"}</span>
              </Link>
            )}
            <button
              type="button"
              onClick={() => selectMode(mode === "dark" ? "light" : "dark")}
              aria-label="Toggle color theme"
              className="inline-flex h-7 items-center rounded-md border border-zinc-200/80 px-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400"
            >
              {mode === "dark" ? "Light" : "Dark"}
            </button>
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
              className="inline-flex h-7 items-center rounded-md border border-zinc-200/80 px-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400"
            >
              ⌘K
            </button>
          </div>
        </header>

        <Suspense fallback={<main className="flex min-h-0 flex-1 flex-col">{children}</main>}>
          <MainFrame>{children}</MainFrame>
        </Suspense>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
