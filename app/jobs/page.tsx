import { Suspense } from "react";
import { JobsList } from "@/app/_components/jobs-list";
import { Loading } from "@/app/_components/ui";

export default function JobsPage() {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">Jobs</h1>
        <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
          Track active runs, pending approvals, and completed pull requests.
        </p>
      </div>
      <Suspense fallback={<Loading label="Loading jobs" />}>
        <JobsList />
      </Suspense>
    </div>
  );
}
