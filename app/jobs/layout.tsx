import { Suspense, type ReactNode } from "react";
import { JobsList } from "@/app/_components/jobs-list";
import { Loading } from "@/app/_components/ui";

export default function JobsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row md:overflow-hidden">
      <Suspense
        fallback={
          <aside className="w-full shrink-0 border-r border-zinc-200/80 bg-white p-4 md:w-80 lg:w-[22rem] dark:border-zinc-800/80 dark:bg-zinc-950">
            <Loading label="Loading jobs" />
          </aside>
        }
      >
        <JobsList />
      </Suspense>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-zinc-50/50 dark:bg-zinc-950/60">{children}</div>
    </div>
  );
}
