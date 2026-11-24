import { Suspense } from "react";
import { JobsList } from "@/app/_components/jobs-list";
import { Loading } from "@/app/_components/ui";

export default function JobsPage() {
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold text-zinc-900 dark:text-zinc-100">Jobs</h1>
      <Suspense fallback={<Loading label="Loading jobs" />}>
        <JobsList />
      </Suspense>
    </>
  );
}
