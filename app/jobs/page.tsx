import Link from "next/link";
import { EmptyState } from "@/app/_components/ui";

export default function JobsPage() {
  return (
    <div className="hidden flex-1 flex-col items-center justify-center p-6 md:flex">
      <EmptyState
        icon={
          <svg aria-hidden viewBox="0 0 16 16" fill="none" className="h-4 w-4">
            <path d="M3 4.5H13M3 8H13M3 11.5H9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        }
        title="Select a job"
        description="Choose a run from the list to inspect its plan, checks, and code changes, or start a new run from an open GitHub issue."
        action={
          <Link
            href="/"
            className="inline-flex h-8 items-center rounded-md bg-zinc-900 px-3.5 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            + New job
          </Link>
        }
      />
    </div>
  );
}
