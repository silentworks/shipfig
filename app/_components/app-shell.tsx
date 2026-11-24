"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { AWAITING_HUMAN_STATES, STATE_LABELS } from "@/lib/jobs/states";
import type { Job } from "@/lib/jobs/store";
import { fetchJson } from "./api";
import { CommandPalette } from "./command-palette";
import { Kbd } from "./ui";

const ACTIVE_POLL_MS = 5_000;

function useActiveJob() {
  const [job, setJob] = useState<Job | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      if (document.visibilityState === "hidden") {
        timer = setTimeout(poll, ACTIVE_POLL_MS);
        return;
      }
      try {
        const data = await fetchJson<{ jobs: Job[]; activeJobId: string | null }>("/api/jobs");
        if (!stopped) setJob(data.jobs.find((j) => j.id === data.activeJobId) ?? null);
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

  return job;
}

function Breadcrumbs() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const repo = searchParams.get("repo");
  const issue = searchParams.get("issue");

  if (pathname === "/") {
    return (
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-500">
        <Link href="/" className="font-medium text-zinc-900 hover:underline dark:text-zinc-100">
          Issues
        </Link>
        {repo && (
          <>
            <span aria-hidden className="text-zinc-300 dark:text-zinc-700">/</span>
            <Link href={`/?repo=${encodeURIComponent(repo)}`} className="truncate font-mono hover:text-zinc-900 dark:hover:text-zinc-100">
              {repo}
            </Link>
          </>
        )}
        {repo && issue && (
          <>
            <span aria-hidden className="text-zinc-300 dark:text-zinc-700">/</span>
            <span className="font-mono text-zinc-900 dark:text-zinc-100">#{issue}</span>
          </>
        )}
      </nav>
    );
  }

  if (pathname === "/jobs") {
    return (
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs">
        <span className="font-medium text-zinc-900 dark:text-zinc-100">Jobs</span>
      </nav>
    );
  }

  if (pathname.startsWith("/jobs/")) {
    const id = pathname.slice("/jobs/".length);
    return (
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-500">
        <Link href="/jobs" className="hover:text-zinc-900 dark:hover:text-zinc-100">
          Jobs
        </Link>
        <span aria-hidden className="text-zinc-300 dark:text-zinc-700">/</span>
        <span className="truncate font-mono text-zinc-900 dark:text-zinc-100">{id}</span>
      </nav>
    );
  }

  return null;
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

function SidebarNav({ pathname }: { pathname: string | null }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5 px-2.5">
      {NAV_ITEMS.map((item) => {
        const active = pathname !== null && item.isActive(pathname);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors ${
              active
                ? "bg-zinc-200/70 text-zinc-900 dark:bg-zinc-800/80 dark:text-zinc-100"
                : "text-zinc-600 hover:bg-zinc-200/40 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
            }`}
          >
            {item.icon}
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function SidebarNavDynamic() {
  const pathname = usePathname();
  return <SidebarNav pathname={pathname} />;
}

function MobileNav({ pathname }: { pathname: string | null }) {
  return (
    <nav aria-label="Mobile" className="flex items-center gap-2 text-xs md:hidden">
      {NAV_ITEMS.map((item) => {
        const active = pathname !== null && item.isActive(pathname);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`rounded px-2 py-1 font-medium ${
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

export function AppShell({ children }: { children: ReactNode }) {
  const activeJob = useActiveJob();
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
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* Persistent Linear-style sidebar (desktop) */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-zinc-200/80 bg-zinc-50/70 md:flex dark:border-zinc-800/80 dark:bg-zinc-950/70">
        <div className="flex h-12 items-center gap-2 border-b border-zinc-200/80 px-4 dark:border-zinc-800/80">
          <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-zinc-900 text-[11px] font-bold text-white dark:bg-zinc-100 dark:text-zinc-900">
              S
            </span>
            <span>Shipfig</span>
          </Link>
        </div>

        <div className="p-2.5">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex w-full items-center justify-between gap-2 rounded-md border border-zinc-200/80 bg-white px-2.5 py-1.5 text-xs text-zinc-500 transition-colors hover:border-zinc-300 hover:text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-200"
          >
            <span className="flex items-center gap-2">
              <svg aria-hidden viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
                <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
                <path d="M10.5 10.5L13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <span>Jump to…</span>
            </span>
            <Kbd>⌘K</Kbd>
          </button>
        </div>

        <Suspense fallback={<SidebarNav pathname={null} />}>
          <SidebarNavDynamic />
        </Suspense>

        {activeJob && (
          <div className="mt-auto p-2.5">
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
              <p className="mt-1 truncate font-mono text-[11px] opacity-80">
                {activeJob.repoOwner}/{activeJob.repoName}#{activeJob.issueNumber}
              </p>
              <p className="mt-0.5 truncate text-[11px] opacity-75">{STATE_LABELS[activeJob.state]}</p>
            </Link>
          </div>
        )}
      </aside>

      {/* Main content area */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-12 items-center justify-between gap-3 border-b border-zinc-200/80 bg-white/85 px-4 backdrop-blur-md dark:border-zinc-800/80 dark:bg-zinc-950/85">
          <div className="flex min-w-0 items-center gap-3">
            {/* Mobile brand & nav */}
            <Link href="/" className="flex items-center gap-1.5 text-sm font-semibold tracking-tight md:hidden">
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-zinc-900 text-[11px] font-bold text-white dark:bg-zinc-100 dark:text-zinc-900">
                S
              </span>
              <span>Shipfig</span>
            </Link>
            <Suspense fallback={<MobileNav pathname={null} />}>
              <MobileNavDynamic />
            </Suspense>

            <div className="hidden min-w-0 md:block">
              <Suspense fallback={null}>
                <Breadcrumbs />
              </Suspense>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {activeJob && (
              <Link
                href={`/jobs/${activeJob.id}`}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium md:hidden ${
                  needsYou
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300"
                    : "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                }`}
              >
                <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${needsYou ? "bg-amber-500" : "bg-sky-500 animate-pulse"}`} />
                <span>{needsYou ? "Approval needed" : "Active job"}</span>
              </Link>
            )}
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200/80 px-2 py-1 text-xs text-zinc-500 transition-colors hover:border-zinc-300 hover:text-zinc-800 md:hidden dark:border-zinc-800 dark:text-zinc-400"
            >
              <span>Search</span>
              <Kbd>⌘K</Kbd>
            </button>
          </div>
        </header>

        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-6 sm:px-6">{children}</main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
