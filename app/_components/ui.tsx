"use client";

import { useState, type ReactNode } from "react";

export type BadgeTone = "completed" | "failed" | "canceled" | "waiting" | "working" | "neutral";

const BADGE_STYLES: Record<BadgeTone, { pill: string; dot: string }> = {
  completed: {
    pill: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  failed: {
    pill: "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300",
    dot: "bg-red-500",
  },
  canceled: {
    pill: "border-zinc-400/30 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
    dot: "bg-zinc-400",
  },
  waiting: {
    pill: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  working: {
    pill: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500 motion-safe:animate-pulse",
  },
  neutral: {
    pill: "border-zinc-300/70 bg-zinc-100 text-zinc-700 dark:border-zinc-700/70 dark:bg-zinc-800/80 dark:text-zinc-300",
    dot: "bg-zinc-400",
  },
};

export function StatusBadge({
  tone,
  children,
  pulse = false,
  className = "",
}: {
  tone: BadgeTone;
  children: ReactNode;
  pulse?: boolean;
  className?: string;
}) {
  const style = BADGE_STYLES[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${style.pill} ${className}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot} ${pulse ? "motion-safe:animate-pulse" : ""}`} />
      <span>{children}</span>
    </span>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  noPadding = false,
  className = "",
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  noPadding?: boolean;
  className?: string;
}) {
  return (
    <section
      className={`flex min-h-0 flex-col rounded-lg border border-zinc-200/80 bg-white dark:border-zinc-800/80 dark:bg-zinc-950 ${className}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200/80 px-4 py-2.5 dark:border-zinc-800/80">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{description}</p>}
        </div>
        {actions}
      </header>
      <div className={`min-h-0 flex-1 ${noPadding ? "" : "p-4"}`}>{children}</div>
    </section>
  );
}

export function CollapsiblePanel({
  title,
  summary,
  badge,
  actions,
  defaultOpen = false,
  children,
  noPadding = false,
}: {
  title: string;
  summary?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  noPadding?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="flex min-h-0 flex-col rounded-lg border border-zinc-200/80 bg-white dark:border-zinc-800/80 dark:bg-zinc-950">
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="group flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500"
        >
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            fill="none"
            className={`h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform duration-150 group-hover:text-zinc-700 dark:group-hover:text-zinc-200 ${open ? "rotate-90" : ""}`}
          >
            <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-600 group-hover:text-zinc-900 dark:text-zinc-400 dark:group-hover:text-zinc-100">
            {title}
          </span>
          {badge}
          {!open && summary && <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">{summary}</span>}
        </button>
        {open && actions}
      </header>
      {open && (
        <div className={`min-h-0 flex-1 border-t border-zinc-200/80 dark:border-zinc-800/80 ${noPadding ? "" : "p-4"}`}>
          {children}
        </div>
      )}
    </section>
  );
}

export function Muted({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-sm text-zinc-500 dark:text-zinc-400 ${className}`}>{children}</p>;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon && (
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-200/80 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{title}</p>
      {description && <p className="mt-1 max-w-sm text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-2">
      <span className="sr-only">{label}</span>
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-9 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-900" />
      ))}
    </div>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-800 dark:text-red-200"
    >
      <p className="break-words">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="text-xs font-medium underline underline-offset-2 hover:opacity-80">
          Try again
        </button>
      )}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex items-center rounded border border-zinc-200 bg-zinc-100/80 px-1.5 py-0.5 font-mono text-[10px] font-medium text-zinc-500 dark:border-zinc-700/80 dark:bg-zinc-800/80 dark:text-zinc-400">
      {children}
    </kbd>
  );
}

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
}) {
  const styles = {
    primary: "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300",
    secondary:
      "border border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700/80 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800",
    ghost: "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/80 dark:hover:text-zinc-100",
    danger:
      "border border-red-500/30 bg-white text-red-700 hover:bg-red-50 dark:border-red-500/30 dark:bg-zinc-950 dark:text-red-300 dark:hover:bg-red-950/50",
  }[variant];
  const sizes = {
    sm: "h-7 px-2.5 text-xs",
    md: "h-8 px-3.5 text-xs",
  }[size];
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 disabled:cursor-not-allowed disabled:opacity-50 ${sizes} ${styles} ${className}`}
    />
  );
}
